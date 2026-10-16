// Tests approval command behavior for pending tool and execution requests.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelApprovalCapability,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import { markImplicitSameChatApprovalAuthorization } from "../../plugin-sdk/approval-auth-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleApproveCommandFromContext as handleApproveCommand } from "./commands-approve.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());
const isPendingSystemAgentApprovalMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/approval-gateway-resolver.js", () => ({
  isPendingSystemAgentApprovalOverGateway: isPendingSystemAgentApprovalMock,
  resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const requireRecord = createRequireRecord("record", "expected-label-object");

function approvalResolverRequest(callIndex = 0) {
  const call = resolveApprovalOverGatewayMock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected approval resolver call ${callIndex}`);
  }
  return requireRecord(call[0], `approval resolver call ${callIndex} request`);
}

function expectApprovalResolverCall(params: {
  callIndex?: number;
  method: string;
  id: string;
  decision?: string;
}) {
  const request = approvalResolverRequest(params.callIndex ?? 0);
  expect(request).toHaveProperty("cfg");
  const hasReviewer = Object.hasOwn(request, "channel");
  expect(Object.hasOwn(request, "accountId")).toBe(hasReviewer);
  expect(Object.hasOwn(request, "senderId")).toBe(hasReviewer);
  expect(request.approvalId).toBe(params.id);
  expect(request.decision).toBe(params.decision ?? "allow-once");
  expect(request.resolveMethod).toBe(
    params.method === "plugin.approval.resolve" ? "plugin" : "exec",
  );
  expect(request.clientDisplayName).toMatch(/^Chat approval \(.+\)$/);
}

type ApprovalTestPolicy = Partial<
  Record<
    ChannelApprovalKind,
    { authorizedSenders: readonly string[]; accountId?: string; reply?: string }
  >
>;

const approvalPolicies = new WeakMap<OpenClawConfig, ApprovalTestPolicy>();

function withApprovalPolicy(cfg: OpenClawConfig, policy: ApprovalTestPolicy): OpenClawConfig {
  approvalPolicies.set(cfg, policy);
  return cfg;
}

const createApprovalCapability = (channelLabel: string): ChannelApprovalCapability => ({
  authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) => {
    const policy = approvalPolicies.get(cfg)?.[approvalKind];
    if (!policy) {
      return markImplicitSameChatApprovalAuthorization({ authorized: true });
    }
    if (
      senderId &&
      policy.authorizedSenders.includes(senderId) &&
      (!policy.accountId || policy.accountId === accountId)
    ) {
      return { authorized: true };
    }
    return {
      authorized: false,
      reason: `❌ You are not authorized to approve ${approvalKind} requests on ${channelLabel}.`,
    };
  },
  resolveApproveCommandBehavior: ({ cfg, approvalKind }) => {
    const reply = approvalPolicies.get(cfg)?.[approvalKind]?.reply;
    return reply ? { kind: "reply", text: reply } : undefined;
  },
});

function createApprovalTestPlugin(id: string, label: string, approvals = false): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id, label }),
    approvalCapability: approvals ? createApprovalCapability(label) : undefined,
  };
}

const telegramApproveTestPlugin = createApprovalTestPlugin("telegram", "Telegram", true);
telegramApproveTestPlugin.config.defaultAccountId = (cfg) =>
  cfg.channels?.telegram?.defaultAccount ?? "default";
const discordApproveTestPlugin = createApprovalTestPlugin("discord", "Discord", true);
const signalApproveTestPlugin = createApprovalTestPlugin("signal", "Signal", true);
const slackApproveTestPlugin = createApprovalTestPlugin("slack", "Slack");
const whatsappApproveTestPlugin = createApprovalTestPlugin("whatsapp", "WhatsApp");

function setPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
}

function setApprovePluginRegistry(): void {
  setPlugins(
    discordApproveTestPlugin,
    slackApproveTestPlugin,
    whatsappApproveTestPlugin,
    signalApproveTestPlugin,
    telegramApproveTestPlugin,
  );
}

const channelConfig = (channel = "whatsapp", allowFrom = ["*"]): OpenClawConfig => ({
  commands: { text: true },
  channels: { [channel]: { allowFrom } },
});
const telegramContext = { Provider: "telegram", Surface: "telegram", SenderId: "123" };

function buildApproveParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = channelConfig(),
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    SenderId?: string;
    GatewayClientScopes?: string[];
    AccountId?: string;
    GroupSpace?: string;
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "whatsapp";
  return {
    cfg,
    ctx: {
      Provider: provider,
      Surface: ctxOverrides?.Surface ?? provider,
      CommandSource: "text",
      ...ctxOverrides,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: ctxOverrides?.SenderId ?? "owner",
      channel: provider,
      channelId: provider,
    },
  } as unknown as HandleCommandsParams;
}

const approve = (params: HandleCommandsParams) => handleApproveCommand(params, true);
function expectReply(result: Awaited<ReturnType<typeof approve>>, text: string) {
  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.text).toContain(text);
}

describe("handleApproveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPendingSystemAgentApprovalMock.mockResolvedValue(false);
    setApprovePluginRegistry();
  });

  function createTelegramApproveCfg(
    execApprovals: {
      enabled: boolean;
      approvers: string[];
      target: "dm";
    } | null = { enabled: true, approvers: ["123"], target: "dm" },
  ): OpenClawConfig {
    const approvers = { authorizedSenders: execApprovals?.approvers ?? [] };
    return withApprovalPolicy(
      {
        commands: { text: true },
        channels: {
          telegram: {
            allowFrom: ["*"],
            ...(execApprovals ? { execApprovals } : {}),
          },
        },
      } as OpenClawConfig,
      {
        exec: {
          ...approvers,
          ...(execApprovals?.enabled
            ? {}
            : { reply: "❌ Telegram exec approvals are not enabled for this bot account." }),
        },
        plugin: approvers,
        "system-agent": approvers,
      },
    );
  }

  it("rejects invalid usage", async () => {
    expectReply(await approve(buildApproveParams("/approve")), "Usage: /approve");
  });

  it.each(["constructor"])(
    "rejects Object.prototype decision %s instead of treating it as an approval decision",
    async (decision) => {
      expectReply(await approve(buildApproveParams(`/approve abc ${decision}`)), "Usage: /approve");
      expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("accepts forwarded Telegram plugin approvals from approvers when native delivery is disabled", async () => {
    const params = buildApproveParams(
      "/approve plugin:abc12345 allow-once",
      createTelegramApproveCfg({ enabled: false, approvers: ["123"], target: "dm" }),
      telegramContext,
    );
    params.command.isAuthorizedSender = false;
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);

    expectReply(await approve(params), "Approval allow-once submitted");
    expectApprovalResolverCall({ method: "plugin.approval.resolve", id: "plugin:abc12345" });
  });

  it("passes workspace-qualified Slack plugin reviewers to Gateway without changing exec identity", async () => {
    const slackPlugin = {
      ...slackApproveTestPlugin,
      approvalCapability: {
        ...createApprovalCapability("Slack"),
        resolveReviewerSenderId: ({
          senderId,
          spaceId,
        }: {
          senderId?: string | null;
          spaceId?: string | null;
        }) => `team:${spaceId}:user:${senderId}`,
      },
    };
    setPlugins(slackPlugin);
    const cfg = withApprovalPolicy(channelConfig("slack"), {
      plugin: { authorizedSenders: ["team:T11111111:user:U12345678"] },
      exec: { authorizedSenders: [] },
    });
    const ctx = {
      Provider: "slack",
      Surface: "slack",
      SenderId: "U12345678",
      GroupSpace: "T11111111",
    };
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);

    const plugin = buildApproveParams("/approve plugin:abc allow-once", cfg, ctx);
    plugin.command.isAuthorizedSender = false;
    await approve(plugin);
    expect(approvalResolverRequest(0).senderId).toBe("team:T11111111:user:U12345678");

    resolveApprovalOverGatewayMock.mockClear();
    withApprovalPolicy(cfg, {
      plugin: { authorizedSenders: [] },
      exec: { authorizedSenders: ["U12345678"] },
    });
    await approve(buildApproveParams("/approve exec:abc allow-once", cfg, ctx));
    expect(approvalResolverRequest(0).senderId).toBe("U12345678");
  });

  it("honors the configured default account for omitted-account /approve auth", async () => {
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      withApprovalPolicy(
        {
          commands: { text: true },
          channels: {
            telegram: {
              defaultAccount: "work",
              allowFrom: ["*"],
              accounts: {
                work: {
                  execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
                },
              },
            },
          },
        } as OpenClawConfig,
        {
          exec: { authorizedSenders: ["123"], accountId: "work" },
          plugin: { authorizedSenders: ["123"], accountId: "work" },
        },
      ),
      { ...telegramContext, AccountId: undefined },
    );
    params.command.isAuthorizedSender = false;

    expectReply(await approve(params), "Approval allow-once submitted");
    expectApprovalResolverCall({ method: "exec.approval.resolve", id: "abc12345" });
    expect(approvalResolverRequest()).toMatchObject({ channel: "telegram", accountId: "work" });
  });

  it.each([
    {
      name: "does not treat implicit default approval auth as a bypass for unauthorized senders",
      cfg: { commands: { text: true } } as OpenClawConfig,
      ctx: { Provider: "webchat", Surface: "webchat", SenderId: "123" },
      setup: undefined,
    },
    {
      name: "does not treat implicit same-chat approval auth as a bypass for unauthorized senders",
      cfg: channelConfig("slack"),
      ctx: { Provider: "slack", Surface: "slack", SenderId: "U123" },
      setup: () =>
        setPlugins({
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          approvalCapability: {
            authorizeActorAction: () => ({ authorized: true }),
            getActionAvailabilityState: () => ({ kind: "disabled" }),
          },
        }),
    },
    {
      name: "does not allow empty helper approvers to bypass unauthorized sender checks",
      cfg: channelConfig("signal", []),
      ctx: { Provider: "signal", Surface: "signal", SenderId: "+15551239999" },
      setup: undefined,
    },
  ] as const)("$name", async ({ cfg, ctx, setup }) => {
    setup?.();
    const params = buildApproveParams("/approve abc12345 allow-once", cfg, ctx);
    params.command.isAuthorizedSender = false;

    const result = await approve(params);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
  });

  it("resolves an OpenClaw change approval with its canonical owner", async () => {
    const notFound = () => new Error("unknown or expired approval id");
    resolveApprovalOverGatewayMock
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ applied: true });
    isPendingSystemAgentApprovalMock.mockResolvedValueOnce(true);

    const result = await approve(
      buildApproveParams(
        "/approve system-agent:abc allow-once",
        createTelegramApproveCfg(),
        telegramContext,
      ),
    );

    expect(result?.reply?.text).toContain("Approval allow-once submitted for system-agent:abc");
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(3);
    const canonical = approvalResolverRequest(2);
    expect(canonical).toMatchObject({ approvalKind: "system-agent", decision: "allow-once" });
    expect(canonical.resolveMethod).toBeUndefined();
  });

  describe("OpenClaw change approvals on channels without reviewer custody", () => {
    const approveOnSlack = (owner: { senderIsOwner: boolean; assertOwnerCurrent?: () => void }) => {
      const params = buildApproveParams(
        "/approve system-agent:abc allow-once",
        {},
        { Provider: "slack", Surface: "slack", SenderId: "U123" },
      );
      Object.assign(params.command, owner);
      return approve(params);
    };
    const expectNoCanonicalCalls = () =>
      expect(
        resolveApprovalOverGatewayMock.mock.calls.filter(
          ([request]) => (request as { approvalKind?: string }).approvalKind === "system-agent",
        ),
      ).toHaveLength(0);

    beforeEach(() => {
      resolveApprovalOverGatewayMock.mockRejectedValue(new Error("unknown or expired approval id"));
      isPendingSystemAgentApprovalMock.mockResolvedValue(true);
    });

    it("rejects a command-authorized non-owner before any canonical decision", async () => {
      const result = await approveOnSlack({ senderIsOwner: false });

      expect(result?.reply?.text).toContain("Only the owner can approve OpenClaw changes");
      expectNoCanonicalCalls();
    });

    it("rejects an owner whose authority was revoked before the decision", async () => {
      const result = await approveOnSlack({
        senderIsOwner: true,
        assertOwnerCurrent: () => {
          throw new Error("owner revoked");
        },
      });

      expect(result?.reply?.text).toContain("Check the request in the Control UI");
      expectNoCanonicalCalls();
    });
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const [name, cfg, expectedText, calls, commandBody] of [
      [
        "different bot mention",
        createTelegramApproveCfg(),
        "targets a different Telegram bot",
        0,
        "/approve@otherbot abc12345 allow-once",
      ],
      [
        "unknown approval id",
        createTelegramApproveCfg(),
        "That approval is no longer available",
        2,
      ],
      [
        "disabled native delivery",
        createTelegramApproveCfg(null),
        "Telegram exec approvals are not enabled",
        0,
      ],
      [
        "non approver",
        createTelegramApproveCfg({ enabled: true, approvers: ["999"], target: "dm" }),
        "not authorized to approve",
        0,
      ],
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      if (calls) {
        resolveApprovalOverGatewayMock.mockRejectedValue(
          new Error("unknown or expired approval id"),
        );
      }
      const result = await approve(
        buildApproveParams(commandBody ?? "/approve abc12345 allow-once", cfg, telegramContext),
      );
      expect(result?.shouldContinue, name).toBe(false);
      expect(result?.reply?.text, name).toContain(expectedText);
      expect(resolveApprovalOverGatewayMock, name).toHaveBeenCalledTimes(calls);
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    for (const [scope, expectedText, expectedResolverCalls] of [
      ["operator.write", "requires operator.approvals", 0],
      ["operator.approvals", "Approval allow-once submitted", 1],
      ["operator.admin", "Approval allow-once submitted", 1],
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
      const result = await approve(
        buildApproveParams("/approve abc allow-once", cfg, {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: [scope],
        }),
      );

      expect(result?.shouldContinue, scope).toBe(false);
      expect(result?.reply?.text, scope).toContain(expectedText);
      expect(resolveApprovalOverGatewayMock, scope).toHaveBeenCalledTimes(expectedResolverCalls);
      if (expectedResolverCalls > 0) {
        expectApprovalResolverCall({
          callIndex: resolveApprovalOverGatewayMock.mock.calls.length - 1,
          method: "exec.approval.resolve",
          id: "abc",
        });
        const request = approvalResolverRequest(
          resolveApprovalOverGatewayMock.mock.calls.length - 1,
        );
        expect(request).not.toHaveProperty("channel");
        expect(request).not.toHaveProperty("accountId");
        expect(request).not.toHaveProperty("senderId");
      }
    }
  });
});
