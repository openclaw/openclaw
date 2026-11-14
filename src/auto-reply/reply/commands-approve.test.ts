import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelApprovalCapability,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import { createResolvedApproverActionAuthAdapter } from "../../plugin-sdk/approval-auth-helpers.js";
import { markImplicitSameChatApprovalAuthorization } from "../../plugin-sdk/approval-auth-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleApproveCommandFromContext as handleApproveCommand } from "./commands-approve.js";
import type { HandleCommandsParams } from "./commands-types.js";

const { resolveApprovalOverGatewayMock, isPendingSystemAgentApprovalMock } = vi.hoisted(() => ({
  resolveApprovalOverGatewayMock: vi.fn(),
  isPendingSystemAgentApprovalMock: vi.fn(),
}));

vi.mock("../../infra/approval-gateway-resolver.js", () => ({
  isPendingSystemAgentApprovalOverGateway: isPendingSystemAgentApprovalMock,
  resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const requireRecord = createRequireRecord("record", "expected-label-object");

function approvalResolverRequest(callIndex = 0) {
  return requireRecord(
    resolveApprovalOverGatewayMock.mock.calls[callIndex]?.[0],
    `approval resolver call ${callIndex} request`,
  );
}

function expectApprovalResolverCall(id: string, method = "exec", callIndex = 0) {
  const request = approvalResolverRequest(callIndex);
  expect(request).toHaveProperty("cfg");
  const hasReviewer = Object.hasOwn(request, "channel");
  expect(Object.hasOwn(request, "accountId")).toBe(hasReviewer);
  expect(Object.hasOwn(request, "senderId")).toBe(hasReviewer);
  expect(request).toMatchObject({
    approvalId: id,
    decision: "allow-once",
    resolveMethod: method,
    clientDisplayName: expect.stringMatching(/^Chat approval \(.+\)$/),
  });
}

type ApprovalTestPolicy = {
  [K in ChannelApprovalKind]?: {
    authorizedSenders: readonly string[];
    accountId?: string;
    reply?: string;
  };
};

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
const slackApproveTestPlugin = createApprovalTestPlugin("slack", "Slack");
const whatsappApproveTestPlugin = createApprovalTestPlugin("whatsapp", "WhatsApp");

function setPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" }))),
  );
}

const channelConfig = (channel = "whatsapp", allowFrom = ["*"]): OpenClawConfig => ({
  commands: { text: true },
  channels: { [channel]: { allowFrom } },
});
const channelContext = (channel: string, senderId: string) => ({
  Provider: channel,
  Surface: channel,
  SenderId: senderId,
});
const telegramContext = channelContext("telegram", "123");

function buildApproveParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = channelConfig(),
  ctxOverrides?: Partial<
    Pick<
      HandleCommandsParams["ctx"],
      "Provider" | "Surface" | "SenderId" | "GatewayClientScopes" | "AccountId" | "GroupSpace"
    >
  >,
  commandOverrides?: Partial<HandleCommandsParams["command"]>,
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
      ...commandOverrides,
    },
  } as unknown as HandleCommandsParams;
}

const approve = (params: HandleCommandsParams) => handleApproveCommand(params, true);
const approveTelegram = (
  cfg: OpenClawConfig,
  body = "/approve abc12345 allow-once",
  command?: Partial<HandleCommandsParams["command"]>,
) => approve(buildApproveParams(body, cfg, telegramContext, command));
function expectReply(result: Awaited<ReturnType<typeof approve>>, text: string) {
  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.text).toContain(text);
}

describe("handleApproveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalOverGatewayMock.mockReset().mockResolvedValue(undefined);
    isPendingSystemAgentApprovalMock.mockResolvedValue(false);
    setPlugins(slackApproveTestPlugin, whatsappApproveTestPlugin, telegramApproveTestPlugin);
  });

  function createTelegramApproveCfg(
    enabled: boolean | null = true,
    senders = ["123"],
    accountId?: string,
  ): OpenClawConfig {
    const approvers = {
      authorizedSenders: enabled === null ? [] : senders,
      ...(accountId ? { accountId } : {}),
    };
    return withApprovalPolicy(
      { commands: { text: true }, channels: { telegram: { defaultAccount: accountId } } },
      {
        exec: {
          ...approvers,
          ...(enabled
            ? {}
            : { reply: "❌ Telegram exec approvals are not enabled for this bot account." }),
        },
        plugin: approvers,
        ...(!accountId ? { "system-agent": approvers } : {}),
      },
    );
  }

  it.each(["/approve", "/approve abc constructor"])("rejects invalid usage %s", async (body) => {
    expectReply(await approve(buildApproveParams(body)), "Usage: /approve");
    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
  });

  it("accepts forwarded Telegram plugin approvals from approvers when native delivery is disabled", async () => {
    const result = await approveTelegram(
      createTelegramApproveCfg(false),
      "/approve plugin:abc12345 allow-once",
      { isAuthorizedSender: false },
    );
    expectReply(result, "Approval allow-once submitted");
    expectApprovalResolverCall("plugin:abc12345", "plugin");
  });

  it("passes workspace-qualified Slack plugin reviewers to Gateway without changing exec identity", async () => {
    setPlugins({
      ...slackApproveTestPlugin,
      approvalCapability: {
        ...createApprovalCapability("Slack"),
        resolveReviewerSenderId: ({ senderId, spaceId }) => `team:${spaceId}:user:${senderId}`,
      },
    });
    const cfg = withApprovalPolicy(channelConfig("slack"), {
      plugin: { authorizedSenders: ["team:T11111111:user:U12345678"] },
      exec: { authorizedSenders: [] },
    });
    const ctx = {
      ...channelContext("slack", "U12345678"),
      GroupSpace: "T11111111",
    };

    await approve(
      buildApproveParams("/approve plugin:abc allow-once", cfg, ctx, { isAuthorizedSender: false }),
    );
    expect(approvalResolverRequest(0).senderId).toBe("team:T11111111:user:U12345678");
    expect(approvalResolverRequest(0).resolveMethod).toBe("plugin");

    resolveApprovalOverGatewayMock.mockClear();
    withApprovalPolicy(cfg, {
      plugin: { authorizedSenders: [] },
      exec: { authorizedSenders: ["U12345678"] },
    });
    await approve(
      buildApproveParams("/approve exec:abc allow-once", cfg, ctx, { isAuthorizedSender: false }),
    );
    expect(approvalResolverRequest(0).senderId).toBe("U12345678");
    expect(approvalResolverRequest(0).resolveMethod).toBe("exec");
  });

  it("honors the configured default account for omitted-account /approve auth", async () => {
    const result = await approveTelegram(
      createTelegramApproveCfg(true, ["123"], "work"),
      undefined,
      { isAuthorizedSender: false },
    );
    expectReply(result, "Approval allow-once submitted");
    expectApprovalResolverCall("abc12345");
    expect(approvalResolverRequest()).toMatchObject({ channel: "telegram", accountId: "work" });
  });

  it.each(["no override", "disabled", "empty approvers"] as const)(
    "keeps %s approval authorization implicit at the command boundary",
    async (name) => {
      const availability = vi.fn(() => ({ kind: "disabled" as const }));
      const capability: ChannelApprovalCapability | undefined =
        name === "disabled"
          ? {
              authorizeActorAction: () => ({ authorized: true }),
              getActionAvailabilityState: availability,
            }
          : name === "empty approvers"
            ? createResolvedApproverActionAuthAdapter({
                channelLabel: "QuietChat",
                resolveApprovers: () => [],
              })
            : undefined;
      const channel =
        name === "no override" ? "webchat" : name === "empty approvers" ? "quietchat" : "slack";
      setPlugins({ ...createApprovalTestPlugin(channel, channel), approvalCapability: capability });
      const cfg: OpenClawConfig = { commands: { text: true } };
      for (const isAuthorizedSender of [false, true]) {
        resolveApprovalOverGatewayMock.mockClear();
        const result = await approve(
          buildApproveParams(
            "/approve abc12345 allow-once",
            cfg,
            {
              ...channelContext(channel, "uuid:attacker"),
              AccountId: name === "no override" ? undefined : "work",
            },
            { isAuthorizedSender },
          ),
        );
        expect(result?.shouldContinue).toBe(false);
        if (isAuthorizedSender) {
          expectReply(result, "Approval allow-once submitted");
          expectApprovalResolverCall("abc12345");
          expect(resolveApprovalOverGatewayMock).toHaveBeenCalledOnce();
        } else {
          expect(result?.reply).toBeUndefined();
          expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
        }
      }
      if (name === "disabled") {
        expect(availability).toHaveBeenCalledWith({
          cfg,
          accountId: "work",
          action: "approve",
          approvalKind: "exec",
        });
      }
    },
  );

  it("rejects legacy channel reviewer policy before plugin authorization or submission", async () => {
    const authorizeActorAction = vi.fn(
      ({ approvalKind }: { approvalKind: ChannelApprovalKind }) => ({
        authorized: approvalKind === "plugin",
      }),
    );
    setPlugins({ ...slackApproveTestPlugin, approvalCapability: { authorizeActorAction } });
    const cfg: OpenClawConfig = {
      commands: { text: true },
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    };
    const result = await approve(
      buildApproveParams("/approve plugin:abc12345 allow-once", cfg, {
        ...channelContext("slack", "U22222222"),
        AccountId: "default",
      }),
    );
    expectReply(result, "require an updated channel plugin");
    expect(authorizeActorAction.mock.calls.some(([input]) => input.approvalKind === "plugin")).toBe(
      false,
    );
    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
  });

  it("resolves an OpenClaw change approval with its canonical owner", async () => {
    const notFound = () => new Error("unknown or expired approval id");
    resolveApprovalOverGatewayMock
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ applied: true });
    isPendingSystemAgentApprovalMock.mockResolvedValueOnce(true);

    expectReply(
      await approveTelegram(createTelegramApproveCfg(), "/approve system-agent:abc allow-once"),
      "Approval allow-once submitted for system-agent:abc",
    );
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(3);
    const canonical = approvalResolverRequest(2);
    expect(canonical).toMatchObject({ approvalKind: "system-agent", decision: "allow-once" });
    expect(canonical.resolveMethod).toBeUndefined();
  });

  it.each([
    ["command-authorized non-owner", false, "Only the owner can approve OpenClaw changes"],
    ["owner revoked before decision", true, "Check the request in the Control UI"],
  ] as const)("rejects %s without reviewer custody", async (_name, senderIsOwner, text) => {
    resolveApprovalOverGatewayMock.mockRejectedValue(new Error("unknown or expired approval id"));
    isPendingSystemAgentApprovalMock.mockResolvedValue(true);
    const params = buildApproveParams(
      "/approve system-agent:abc allow-once",
      {},
      channelContext("slack", "U123"),
      {
        senderIsOwner,
        assertOwnerCurrent: senderIsOwner
          ? () => {
              throw new Error("owner revoked");
            }
          : undefined,
      },
    );
    expect((await approve(params))?.reply?.text).toContain(text);
    expect(
      resolveApprovalOverGatewayMock.mock.calls.filter(
        ([request]) => (request as { approvalKind?: string }).approvalKind === "system-agent",
      ),
    ).toHaveLength(0);
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const [cfg, expectedText, calls, commandBody] of [
      [
        createTelegramApproveCfg(),
        "targets a different Telegram bot",
        0,
        "/approve@otherbot abc12345 allow-once",
      ],
      [createTelegramApproveCfg(), "That approval is no longer available", 2],
      [createTelegramApproveCfg(null), "Telegram exec approvals are not enabled", 0],
      [createTelegramApproveCfg(true, ["999"]), "not authorized to approve", 0],
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      if (calls) {
        resolveApprovalOverGatewayMock.mockRejectedValue(
          new Error("unknown or expired approval id"),
        );
      }
      expectReply(await approveTelegram(cfg, commandBody), expectedText);
      expect(resolveApprovalOverGatewayMock, expectedText).toHaveBeenCalledTimes(calls);
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg: OpenClawConfig = { commands: { text: true } };
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
        const callIndex = resolveApprovalOverGatewayMock.mock.calls.length - 1;
        expectApprovalResolverCall("abc", "exec", callIndex);
        const request = approvalResolverRequest(callIndex);
        expect(request).not.toHaveProperty("channel");
        expect(request).not.toHaveProperty("accountId");
        expect(request).not.toHaveProperty("senderId");
      }
    }
  });
});
