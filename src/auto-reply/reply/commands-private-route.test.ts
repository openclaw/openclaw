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

function createApprovalChannelPlugin(
  id: "discord" | "telegram" | "whatsapp",
  targets: Array<{ to: string; threadId?: string | number | null }>,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id, label: id }),
    approvalCapability: {
      native: {
        describeDeliveryCapabilities: vi.fn(() => ({
          enabled: true,
          preferredSurface: "approver-dm" as const,
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        })),
        resolveApproverDmTargets: vi.fn(() => targets),
      },
    },
  };
}

function createOwnerDerivedApprovalChannelPlugin(): ChannelPlugin {
  const ownerPrefixes = ["telegram", "tg"];
  const resolveOwnerTargets = (cfg: OpenClawConfig) =>
    (cfg.commands?.ownerAllowFrom ?? [])
      .map((owner) => String(owner))
      .flatMap((owner) => {
        const trimmed = owner.trim();
        const prefix = ownerPrefixes.find((candidate) =>
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
    ...createChannelTestPluginBase({ id: "telegram", label: "telegram" }),
    messaging: { targetPrefixes: ownerPrefixes },
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

const routeRequest = {
  id: "diagnostics-private-route",
  command: "openclaw gateway diagnostics export --json",
};

function buildCommandParams(cfg: OpenClawConfig = {}): HandleCommandsParams {
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
  } as unknown as HandleCommandsParams;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("preserves command identity and bounds private route expiry with an overflowing clock", async () => {
  const createdAtMs = MAX_DATE_TIMESTAMP_MS;
  vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
  const plugin = createApprovalChannelPlugin("discord", []);
  registerApprovalChannelPlugins([plugin]);
  const commandParams = buildCommandParams();
  commandParams.ctx.OriginatingTo = "origin-group";
  commandParams.ctx.MessageThreadId = 42;
  await resolvePrivateCommandRouteTargets({
    commandParams,
    ...routeRequest,
    commandArgv: ["openclaw", "gateway", "diagnostics", "export", "--json"],
  });
  expect(plugin.approvalCapability?.native?.resolveApproverDmTargets).toHaveBeenCalledWith(
    expect.objectContaining({
      request: {
        approvalKind: "exec",
        id: "diagnostics-private-route",
        request: {
          command: routeRequest.command,
          commandArgv: ["openclaw", "gateway", "diagnostics", "export", "--json"],
          agentId: "main",
          sessionKey: commandParams.sessionKey,
          turnSourceChannel: "discord",
          turnSourceTo: "origin-group",
          turnSourceAccountId: "discord-bot-account",
          turnSourceThreadId: "42",
        },
        createdAtMs,
        expiresAtMs: 0,
      },
    }),
  );
});

it("preserves origin reviewer custody when delivery moves to a private target", () => {
  const commandParams = buildCommandParams();
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

function telegramTarget() {
  return { channel: "telegram", to: "849985193", accountId: undefined, threadId: undefined };
}

describe("resolvePrivateCommandRouteTargets", () => {
  it.each([
    {
      name: "prefers same-surface owners over the first configured owner",
      plugins: () => [
        createApprovalChannelPlugin("telegram", [{ to: "849985193" }]),
        createApprovalChannelPlugin("discord", [{ to: "493655423946194964" }]),
      ],
      owners: ["telegram:849985193", "discord:493655423946194964"],
      expected: [
        {
          channel: "discord",
          to: "493655423946194964",
          accountId: "discord-bot-account",
          threadId: undefined,
        },
        telegramTarget(),
      ],
    },
    {
      name: "falls back to configured owner order without a same-surface route",
      plugins: () => [
        createApprovalChannelPlugin("discord", []),
        createApprovalChannelPlugin("whatsapp", [{ to: "+15555550100" }]),
        createApprovalChannelPlugin("telegram", [{ to: "849985193" }]),
      ],
      owners: ["discord:493655423946194964", "telegram:849985193", "whatsapp:+15555550100"],
      expected: [
        telegramTarget(),
        { channel: "whatsapp", to: "+15555550100", accountId: undefined, threadId: undefined },
      ],
    },
    {
      name: "excludes a same-surface approver that is not an owner",
      plugins: () => [
        createApprovalChannelPlugin("discord", [{ to: "non-owner-approver" }]),
        createApprovalChannelPlugin("telegram", [{ to: "849985193" }]),
      ],
      owners: ["telegram:849985193"],
      expected: [telegramTarget()],
    },
  ])("$name", async ({ plugins, owners, expected }) => {
    registerApprovalChannelPlugins(plugins());
    expect(
      await resolvePrivateCommandRouteTargets({
        commandParams: buildCommandParams({ commands: { ownerAllowFrom: owners } }),
        ...routeRequest,
      }),
    ).toEqual(expected);
  });

  it("routes a Discord group command through Telegram's declared tg owner prefix", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin("discord", []),
      createOwnerDerivedApprovalChannelPlugin(),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: { ownerAllowFrom: ["tg:849985193"] },
        channels: { telegram: { botToken: "test-token" } },
      }),
      ...routeRequest,
    });

    expect(targets).toEqual([telegramTarget()]);
  });
});
