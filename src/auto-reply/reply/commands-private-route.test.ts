// Tests private-route command persistence and timestamp bounds.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import {
  buildCommandExecApprovalDefaults,
  resolvePrivateCommandRouteTargets,
} from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";

function createApprovalChannelPlugin(params: {
  id: "discord" | "telegram" | "whatsapp";
  targets: Array<{ to: string; threadId?: string | number | null }>;
  enabled?: boolean;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.id,
    }),
    approvalCapability: {
      native: {
        describeDeliveryCapabilities: vi.fn(() => ({
          enabled: params.enabled !== false,
          preferredSurface: "approver-dm" as const,
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        })),
        resolveApproverDmTargets: vi.fn(() => params.targets),
      },
    },
  };
}

function createOwnerDerivedApprovalChannelPlugin(params: {
  id: "telegram";
  ownerPrefixes: string[];
}): ChannelPlugin {
  const resolveOwnerTargets = (cfg: OpenClawConfig) =>
    (cfg.commands?.ownerAllowFrom ?? [])
      .map((owner) => String(owner))
      .flatMap((owner) => {
        const trimmed = owner.trim();
        const prefix = params.ownerPrefixes.find((candidate) =>
          trimmed.toLowerCase().startsWith(`${candidate}:`),
        );
        if (prefix) {
          const value = trimmed.slice(prefix.length + 1).trim();
          return value ? [value] : [];
        }
        return /^\d+$/.test(trimmed) ? [trimmed] : [];
      })
      .map((to) => ({ to }));

  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.id,
    }),
    messaging: { targetPrefixes: params.ownerPrefixes },
    approvalCapability: {
      native: {
        describeDeliveryCapabilities: vi.fn(({ cfg }) => {
          const targets = resolveOwnerTargets(cfg);
          return {
            enabled: targets.length > 0,
            preferredSurface: "approver-dm" as const,
            supportsOriginSurface: false,
            supportsApproverDmSurface: true,
          };
        }),
        resolveApproverDmTargets: vi.fn(({ cfg }) => resolveOwnerTargets(cfg)),
      },
    },
  };
}

function registerApprovalChannelPlugins(plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({
        pluginId: plugin.id,
        source: "test",
        plugin,
      })),
    ),
  );
}

function buildCommandParams(cfg: OpenClawConfig): HandleCommandsParams {
  return {
    cfg,
    agentId: "main",
    ctx: {
      Provider: "discord",
      Surface: "discord",
      AccountId: "discord-bot-account",
    } as MsgContext,
    command: {
      commandBodyNormalized: "/diagnostics",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "493655423946194964",
      channel: "discord",
      channelId: "discord",
      surface: "discord",
      ownerList: [],
      rawBodyNormalized: "/diagnostics",
      from: "493655423946194964",
      to: "channel:1487138064806449297",
    },
    sessionKey: "agent:main:discord:channel:1487138064806449297",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: true,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("private command approval requests", () => {
  it.each([["an overflowing clock", MAX_DATE_TIMESTAMP_MS, 0]])(
    "preserves command identity and bounds private route expiry with %s",
    async (_label, createdAtMs, expiresAtMs) => {
      vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
      const plugin = createApprovalChannelPlugin({ id: "discord", targets: [] });
      registerApprovalChannelPlugins([plugin]);
      const commandParams = buildCommandParams({});
      commandParams.ctx.OriginatingTo = "origin-group";
      commandParams.ctx.MessageThreadId = 42;
      await resolvePrivateCommandRouteTargets({
        commandParams,
        id: "diagnostics-private-route",
        command: "openclaw gateway diagnostics export --json",
        commandArgv: ["openclaw", "gateway", "diagnostics", "export", "--json"],
      });
      expect(plugin.approvalCapability?.native?.resolveApproverDmTargets).toHaveBeenCalledWith(
        expect.objectContaining({
          request: {
            approvalKind: "exec",
            id: "diagnostics-private-route",
            request: {
              command: "openclaw gateway diagnostics export --json",
              commandArgv: ["openclaw", "gateway", "diagnostics", "export", "--json"],
              agentId: "main",
              sessionKey: commandParams.sessionKey,
              turnSourceChannel: "discord",
              turnSourceTo: "origin-group",
              turnSourceAccountId: "discord-bot-account",
              turnSourceThreadId: "42",
            },
            createdAtMs,
            expiresAtMs,
          },
        }),
      );
    },
  );
});

describe("buildCommandExecApprovalDefaults", () => {
  it("preserves origin reviewer custody when delivery moves to a private target", () => {
    const commandParams = buildCommandParams({});
    commandParams.ctx.ApprovalReviewerDeviceId = "  device-origin-reviewer  ";

    expect(
      buildCommandExecApprovalDefaults(commandParams, {
        channel: "telegram",
        to: "849985193",
        accountId: "telegram-owner-account",
        threadId: 42,
      }),
    ).toEqual({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      allowBackground: true,
      cwd: "/tmp",
      sessionKey: "agent:main:discord:channel:1487138064806449297",
      eventRouting: { mainKey: undefined, sessionScope: undefined },
      notifyOnExit: undefined,
      notifyOnExitEmptySuccess: undefined,
      messageProvider: "telegram",
      currentChannelId: "849985193",
      currentThreadTs: "42",
      accountId: "telegram-owner-account",
      approvalReviewerDeviceId: "device-origin-reviewer",
    });
  });
});

describe("resolvePrivateCommandRouteTargets", () => {
  it("prefers a same-surface private owner route even when another owner route is listed first", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
      createApprovalChannelPlugin({
        id: "discord",
        targets: [{ to: "493655423946194964" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["telegram:849985193", "discord:493655423946194964"],
        },
      } as OpenClawConfig),
      id: "diagnostics-private-route",
      command: "openclaw gateway diagnostics export --json",
    });

    expect(targets[0]).toEqual({
      channel: "discord",
      to: "493655423946194964",
      accountId: "discord-bot-account",
      threadId: undefined,
    });
    expect(targets[1]).toEqual({
      channel: "telegram",
      to: "849985193",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("falls back to the first configured owner route when the source surface has no private route", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [],
      }),
      createApprovalChannelPlugin({
        id: "whatsapp",
        targets: [{ to: "+15555550100" }],
      }),
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: [
            "discord:493655423946194964",
            "telegram:849985193",
            "whatsapp:+15555550100",
          ],
        },
      } as OpenClawConfig),
      id: "diagnostics-private-route",
      command: "openclaw gateway diagnostics export --json",
    });

    expect(targets[0]?.channel).toBe("telegram");
    expect(targets[0]?.to).toBe("849985193");
    expect(targets[1]?.channel).toBe("whatsapp");
    expect(targets[1]?.to).toBe("+15555550100");
  });

  it("does not select a same-surface exec approver unless it is also an owner route", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [{ to: "non-owner-approver" }],
      }),
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["telegram:849985193"],
        },
      } as OpenClawConfig),
      id: "diagnostics-private-route",
      command: "openclaw gateway diagnostics export --json",
    });

    expect(targets).toEqual([
      {
        channel: "telegram",
        to: "849985193",
        accountId: undefined,
        threadId: undefined,
      },
    ]);
  });

  it("routes a Discord group command through Telegram's declared tg owner prefix", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [],
      }),
      createOwnerDerivedApprovalChannelPlugin({
        id: "telegram",
        ownerPrefixes: ["telegram", "tg"],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["tg:849985193"],
        },
        channels: {
          telegram: {
            botToken: "test-token",
          },
        },
      } as OpenClawConfig),
      id: "diagnostics-private-route",
      command: "openclaw gateway diagnostics export --json",
    });

    expect(targets).toEqual([
      {
        channel: "telegram",
        to: "849985193",
        accountId: undefined,
        threadId: undefined,
      },
    ]);
  });
});
