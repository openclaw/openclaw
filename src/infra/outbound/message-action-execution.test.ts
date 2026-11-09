import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  createPollForwardingPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  readFirstPluginCall,
  readPluginCall,
  readLastPluginCall,
  readMockCallArg,
  readRecordField,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";

type ActionInput = Parameters<typeof runMessageAction>[0];
function runAction(
  channel: string,
  action: ActionInput["action"],
  params: Record<string, unknown>,
  input: Partial<ActionInput> = {},
) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig(channel),
    action,
    params: { channel, ...params },
    dryRun: false,
    ...input,
  });
}

beforeEach(resetMessageActionRunnerMocks);
afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("runMessageAction plugin dispatch", () => {
  describe("alias-based plugin action dispatch", () => {
    const { handleAction } = useActionHubPluginFixture();
    it("dispatches messageId/chatId-based plugin actions through the shared runner", async () => {
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unused-agent-runtime-token");
      await runAction(
        "actionhub",
        "pin",
        { messageId: "om_123" },
        {
          gateway: {
            resolveAgentRuntimeIdentityToken,
            clientName: "gateway-client",
            mode: "backend",
          },
          conversationReadOrigin: "direct-operator",
        },
      );

      await runAction(
        "actionhub",
        "list-pins",
        { chatId: "oc_123" },
        {
          conversationReadOrigin: "direct-operator",
        },
      );

      const pinCall = readPluginCall(handleAction, 0);
      expect(pinCall).toMatchObject({ action: "pin", conversationReadOrigin: "direct-operator" });
      expect(pinCall).toMatchObject({ params: { messageId: "om_123" } });
      const listPinsCall = readPluginCall(handleAction, 1);
      expect(listPinsCall).toMatchObject({ action: "list-pins" });
      expect(listPinsCall).toMatchObject({ params: { chatId: "oc_123" } });
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");
      const context = {
        requesterAccountId: "ops",
        requesterSenderId: "trusted-user",
        conversationReadOrigin: "direct-operator" as const,
        sessionKey: "agent:alpha:main",
        sessionId: "session-123",
        agentId: "alpha",
        inboundEventKind: "room_event" as const,
        toolContext: {
          currentChannelId: "oc_123",
          currentChannelProvider: "actionhub",
          currentThreadTs: "thread-456",
          currentMessageId: "msg-789",
        },
      };

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await runAction(
          "actionhub",
          "pin",
          { messageId: "om_123" },
          {
            defaultAccountId: "ops",
            ...context,
            toolContext: { ...context.toolContext },
          },
        );

        const call = readLastPluginCall(handleAction);
        expect(call).toMatchObject({
          action: "pin",
          accountId: "ops",
          ...context,
          mediaLocalRoots: expect.arrayContaining([expectedWorkspaceRoot]),
        });
      });
    });
  });
  describe("threaded plugin actions", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, params }),
    );
    const cfg = createEnabledMessageActionConfig("forumchat");
    const threading: ChannelPlugin["threading"] = {
      resolveAutoThreadId: ({ toolContext, to }) =>
        toolContext?.currentChannelId === to ? toolContext.currentThreadTs : undefined,
    };
    const createThreadedPlugin = (executionMode: "local" | "gateway") =>
      createGatewayActionPlugin({
        pluginId: "forumchat",
        label: "Forum Chat",
        blurb: "Forum chat threaded action dispatch test plugin.",
        actions: ["sticker", "download-file"],
        gatewayActions: executionMode === "gateway" ? ["sticker", "download-file"] : [],
        capabilities: { chatTypes: ["channel"] },
        threading,
        handleAction,
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
      });

    function runThreadedAction(
      action: "sticker" | "download-file",
      params: Record<string, unknown>,
      gateway = true,
    ) {
      setTestPlugin(createThreadedPlugin(gateway ? "gateway" : "local"), "forumchat");
      if (gateway) {
        mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });
      }
      return runAction("forumchat", action, params, {
        cfg,
        conversationReadOrigin: action === "download-file" ? "direct-operator" : undefined,
        toolContext: {
          currentChannelProvider: "forumchat",
          currentChannelId: "forum:123",
          currentThreadTs: "42",
        },
        gateway: gateway ? { clientName: "cli", mode: "cli" } : undefined,
      });
    }

    function gatewayActionParams() {
      const call = readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call");
      return readRecordField(
        readRecordField(call, "params", "gateway call params"),
        "params",
        "gateway action params",
      );
    }

    it("applies auto threadId before gateway plugin dispatch", async () => {
      await runThreadedAction("sticker", { target: "forum:123", stickerName: "wave" });

      const dispatchedParams = gatewayActionParams();
      expect(dispatchedParams).toMatchObject({ to: "forum:123", threadId: "42" });
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("does not add an implicit thread scope to download-file before gateway dispatch", async () => {
      await runThreadedAction("download-file", { channelId: "forum:123", fileId: "F123" });

      const dispatchedParams = gatewayActionParams();
      expect(dispatchedParams.threadId).toBeUndefined();
      expect(dispatchedParams).toMatchObject({ channelId: "forum:123", fileId: "F123" });
    });

    it("preserves an explicit download-file thread scope", async () => {
      await runThreadedAction(
        "download-file",
        { channelId: "forum:123", fileId: "F123", threadId: "99" },
        false,
      );

      expect(
        readRecordField(readFirstPluginCall(handleAction), "params", "plugin params"),
      ).toMatchObject({ channelId: "forum:123", fileId: "F123", threadId: "99" });
    });
  });
  describe("poll plugin forwarding", () => {
    const pollFields = {
      pollQuestion: "Lunch?",
      pollOption: ["Pizza", "Sushi"],
      pollDurationSeconds: 120,
      pollPublic: true,
      threadId: "42",
    };
    const expectedParams = { to: "pollchat:123", ...pollFields };
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));

    const pollChatPlugin = createPollForwardingPlugin({
      pluginId: "pollchat",
      label: "Poll Chat",
      blurb: "Poll chat forwarding test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(pollChatPlugin, "pollchat");
      handleAction.mockClear();
    });

    it("forwards poll params through plugin dispatch", async () => {
      const result = await runAction(
        "pollchat",
        "poll",
        { target: "pollchat:123", ...pollFields, pollOption: [...pollFields.pollOption] },
        {
          cfg: { channels: { pollchat: { botToken: "tok" } } } as OpenClawConfig,
        },
      );

      expect(result).toMatchObject({ kind: "poll", handledBy: "plugin" });
      expect(readFirstPluginCall(handleAction)).toMatchObject({
        action: "poll",
        channel: "pollchat",
        params: expectedParams,
      });
      expect(result.payload).toMatchObject({ ok: true });
    });
  });
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function readMediaAccess(call: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(call.mediaAccess);
}

function registerPolicyPlugin(id = "policydest", accountIds?: string[]) {
  const handleAction = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
    async ({ mediaAccess }) =>
      jsonResult({
        ok: true,
        hasHostReadCapability: typeof mediaAccess?.readFile === "function",
      }),
  );
  setTestPlugin(
    {
      ...createChannelTestPluginBase({
        id,
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: {
          ...createAlwaysConfiguredPluginConfig(),
          ...(accountIds ? { listAccountIds: () => accountIds } : {}),
        },
      }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    } satisfies ChannelPlugin,
    id,
  );
  return handleAction;
}

function senderReadPolicy(key: string, access: "allow" | "deny" = "deny") {
  return { groups: { ops: { toolsBySender: { [key]: { [access]: ["read"] } } } } };
}

function runHostMediaAction(
  channel: string,
  policy: Record<string, unknown>,
  input: Partial<ActionInput> = {},
  params: Record<string, unknown> = {},
) {
  return runAction(
    channel,
    "send",
    { target: "oc_123", message: "hello", media: "/tmp/host.png", ...params },
    {
      cfg: {
        tools: { allow: ["read"] },
        channels: { [channel]: { enabled: true }, ...policy },
      } as OpenClawConfig,
      ...input,
    },
  );
}

describe("runMessageAction host-media authority", () => {
  it.each([
    ["session channel", "id:trusted-user", "requesterSenderId", "trusted-user"],
    ["username", "username:alice_u", "requesterSenderUsername", "alice_u"],
  ] as const)("uses requester %s policy for host-media reads", async (_name, key, field, value) => {
    const handleAction = registerPolicyPlugin();
    await runHostMediaAction(
      "policydest",
      { requestchat: senderReadPolicy(key) },
      {
        [field]: value,
        sessionKey: "agent:alpha:requestchat:group:ops",
      },
    );
    expect(readMediaAccess(readFirstPluginCall(handleAction)).readFile).toBeUndefined();
  });

  it.each([
    {
      name: "requester account differing from destination",
      channel: "policydest",
      account: "destination",
      policy: {
        requestchat: {
          accounts: {
            source: senderReadPolicy("id:trusted-user"),
            destination: senderReadPolicy("id:trusted-user", "allow"),
          },
        },
      },
      requesterAccountId: "source",
      sessionKey: "agent:alpha:requestchat:group:ops",
      target: "oc_123",
    },
    {
      name: "resolved account when requester is unavailable",
      channel: "policychat",
      account: "source",
      policy: {
        policychat: { enabled: true, accounts: { source: senderReadPolicy("id:trusted-user") } },
      },
      requesterAccountId: undefined,
      sessionKey: "agent:alpha:policychat:group:ops",
      target: "group:ops",
    },
  ])(
    "uses $name policy for host-media reads",
    async ({ channel, account, policy, requesterAccountId, sessionKey, target }) => {
      const handleAction = registerPolicyPlugin(channel, [account]);
      await runHostMediaAction(
        channel,
        policy,
        { requesterAccountId, requesterSenderId: "trusted-user", sessionKey },
        { accountId: account, target },
      );
      const call = readFirstPluginCall(handleAction);
      expect(call.accountId).toBe(account);
      expect(readMediaAccess(call).readFile).toBeUndefined();
    },
  );
});
