// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
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
  expectRecordFields,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction } = useActionHubPluginFixture();
    it("dispatches messageId/chatId-based plugin actions through the shared runner", async () => {
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unused-agent-runtime-token");
      await runMessageAction({
        cfg: createEnabledMessageActionConfig("actionhub"),
        action: "pin",
        params: {
          channel: "actionhub",
          messageId: "om_123",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "gateway-client",
          mode: "backend",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      await runMessageAction({
        cfg: createEnabledMessageActionConfig("actionhub"),
        action: "list-pins",
        params: {
          channel: "actionhub",
          chatId: "oc_123",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      const pinCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        pinCall,
        { action: "pin", conversationReadOrigin: "direct-operator" },
        "pin call",
      );
      expectRecordFields(
        readRecordField(pinCall, "params", "pin call params"),
        { messageId: "om_123" },
        "pin call params",
      );
      const listPinsCall = readPluginCall(handleAction, 1);
      expectRecordFields(listPinsCall, { action: "list-pins" }, "list pins call");
      expectRecordFields(
        readRecordField(listPinsCall, "params", "list pins call params"),
        { chatId: "oc_123" },
        "list pins call params",
      );
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await runMessageAction({
          cfg: createEnabledMessageActionConfig("actionhub"),
          action: "pin",
          params: {
            channel: "actionhub",
            messageId: "om_123",
          },
          defaultAccountId: "ops",
          requesterAccountId: "ops",
          requesterSenderId: "trusted-user",
          conversationReadOrigin: "direct-operator",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundEventKind: "room_event",
          toolContext: {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          dryRun: false,
        });

        const call = readLastPluginCall(handleAction);
        expectRecordFields(
          call,
          {
            action: "pin",
            accountId: "ops",
            requesterAccountId: "ops",
            requesterSenderId: "trusted-user",
            conversationReadOrigin: "direct-operator",
            sessionKey: "agent:alpha:main",
            sessionId: "session-123",
            inboundEventKind: "room_event",
            agentId: "alpha",
          },
          "plugin action call",
        );
        expect(Array.isArray(call.mediaLocalRoots)).toBe(true);
        expect((call.mediaLocalRoots as unknown[]).includes(expectedWorkspaceRoot)).toBe(true);
        expectRecordFields(
          readRecordField(call, "toolContext", "plugin tool context"),
          {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          "plugin tool context",
        );
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

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("applies auto threadId before gateway plugin dispatch", async () => {
      setTestPlugin(createThreadedPlugin("gateway"), "forumchat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

      await runMessageAction({
        cfg,
        action: "sticker",
        params: {
          channel: "forumchat",
          target: "forum:123",
          stickerName: "wave",
        },
        toolContext: {
          currentChannelProvider: "forumchat",
          currentChannelId: "forum:123",
          currentThreadTs: "42",
        },
        gateway: { clientName: "cli", mode: "cli" },
        dryRun: false,
      });

      const dispatchedParams = readRecordField(
        readRecordField(
          readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
          "params",
          "gateway call params",
        ),
        "params",
        "gateway action params",
      );
      expectRecordFields(
        dispatchedParams,
        { to: "forum:123", threadId: "42" },
        "gateway action params",
      );
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("does not add an implicit thread scope to download-file before gateway dispatch", async () => {
      setTestPlugin(createThreadedPlugin("gateway"), "forumchat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

      await runMessageAction({
        cfg,
        action: "download-file",
        conversationReadOrigin: "direct-operator",
        params: {
          channel: "forumchat",
          channelId: "forum:123",
          fileId: "F123",
        },
        toolContext: {
          currentChannelProvider: "forumchat",
          currentChannelId: "forum:123",
          currentThreadTs: "42",
        },
        gateway: { clientName: "cli", mode: "cli" },
        dryRun: false,
      });

      const dispatchedParams = readRecordField(
        readRecordField(
          readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
          "params",
          "gateway call params",
        ),
        "params",
        "gateway action params",
      );
      expect(dispatchedParams.threadId).toBeUndefined();
      expectRecordFields(
        dispatchedParams,
        { channelId: "forum:123", fileId: "F123" },
        "gateway download-file params",
      );
    });

    it("preserves an explicit download-file thread scope", async () => {
      setTestPlugin(createThreadedPlugin("local"), "forumchat");

      await runMessageAction({
        cfg,
        action: "download-file",
        conversationReadOrigin: "direct-operator",
        params: {
          channel: "forumchat",
          channelId: "forum:123",
          fileId: "F123",
          threadId: "99",
        },
        toolContext: {
          currentChannelProvider: "forumchat",
          currentChannelId: "forum:123",
          currentThreadTs: "42",
        },
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readFirstPluginCall(handleAction), "params", "plugin params"),
        { channelId: "forum:123", fileId: "F123", threadId: "99" },
        "local download-file params",
      );
    });
  });
  describe("poll plugin forwarding", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
          threadId: params.threadId ?? null,
        },
      }),
    );

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

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("forwards poll params through plugin dispatch", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            pollchat: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "pollchat",
          target: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "pollchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        "plugin params",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          forwarded: {
            to: "pollchat:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
            threadId: "42",
          },
        },
        "result payload",
      );
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

describe("runMessageAction host-media authority", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it.each([
      [
        "uses requester session channel policy for host-media reads",
        "id:trusted-user",
        "requesterSenderId",
        "trusted-user",
      ],
      [
        "uses requester username policy for host-media reads",
        "username:alice_u",
        "requesterSenderUsername",
        "alice_u",
      ],
    ] as const)("%s", async (_name, policyKey, requesterField, requesterValue) => {
      const handlePolicyCheckedAction = registerPolicyPlugin();

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    [policyKey]: {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        [requesterField]: requesterValue,
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester account policy for host-media reads when destination account differs", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin("policydest", ["destination"]);

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
                destination: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          allow: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          accountId: "destination",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterAccountId: "source",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("destination");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("falls back to the resolved account policy when requester account is unavailable", async () => {
      const handlePolicyCheckedAction = registerPolicyPlugin("policychat", ["source"]);

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policychat: {
              enabled: true,
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policychat",
          accountId: "source",
          target: "group:ops",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:policychat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("source");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });
  });
});
