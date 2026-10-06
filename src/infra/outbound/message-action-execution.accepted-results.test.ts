import "../../test-utils/prepare-compiled-subprocesses.js";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import {
  resolveMessageActionOutcome,
  type MessageActionResult,
  type ResolvedActionContext,
} from "./message-action-contracts.js";
import { annotateSourceDelivery, executeMessagePoll } from "./message-action-execution.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  registerReplyPlugin,
  runCurrentConversationPollAction,
  runReplyAction,
} from "./message-action-runner.test-support.js";

const channel = "accepted-results";
const acceptedToolContext = {
  currentChannelProvider: channel,
  currentChannelId: "room-1",
  currentThreadTs: "thread-1",
};
const authorization = { requesterAccountId: "default", toolContext: acceptedToolContext };
const sessionKey = `agent:main:${channel}:direct:room-1`;
const acceptedPayload = { ok: true, messageId: "accepted-1" };
const closed = new Error("delivery caller closed");

function registerPlugin(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: channel }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("expected native action dispatch");
      },
    },
    ...overrides,
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: channel, plugin, source: "test", origin: "bundled" }]),
  );
  return plugin;
}

describe("accepted results through registered message actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-accepted-results-");
  });
  afterEach(() => resetPluginRuntimeStateForTest());
  afterAll(async () => tempHome.restore());

  it.each([
    { mode: "plugin", messageId: "accepted-1" },
    { mode: "core", messageId: "unknown" },
  ] as const)(
    "retains an accepted $mode send ($messageId) when its caller closes before annotation",
    async ({ mode, messageId }) => {
      let active = true;
      const submitted: string[] = [];
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertCurrent = () => {
        if (!active) {
          throw closed;
        }
      };
      const plugin = registerPlugin(
        mode === "plugin"
          ? {
              actions: {
                describeMessageTool: () => ({ actions: ["send"] }),
                handleAction: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push(messageId);
                  active = false;
                  return jsonResult(acceptedPayload);
                },
              },
            }
          : {
              outbound: {
                deliveryMode: "direct",
                sendText: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push(messageId);
                  active = false;
                  return {
                    channel,
                    messageId,
                    receipt: createMessageReceiptFromOutboundResults({
                      results: messageId === "unknown" ? [] : [{ channel, messageId }],
                      kind: "text",
                    }),
                  };
                },
              },
            },
      );

      const result = await runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: plugin.id, target: "room-1", message: "accepted reply" },
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch,
        skipQueue: true,
        suppressTranscriptMirror: true,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: mode, dryRun: false });
      expect(submitted).toEqual([messageId]);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
      if (result.kind !== "send") {
        throw new Error("Expected send result");
      }
      if (mode === "plugin") {
        expect(result.payload).toBe(acceptedPayload);
        expect(result.toolResult?.details).toBe(acceptedPayload);
      } else {
        expect(result.sendResult).toMatchObject({
          deliveryStatus: "sent",
          result: { messageId },
        });
      }
    },
  );

  it.each(["accepted", "uncertain failure"] as const)(
    "retains a source-authorized broadcast %s after caller closure",
    async (scenario) => {
      const accepted = scenario === "accepted";
      const payload = accepted
        ? acceptedPayload
        : {
            ok: false,
            deliveryStatus: "failed",
            error: "provider result unknown",
            sentBeforeError: true,
          };
      let active = true;
      const handleAction = vi.fn(async () => {
        active = false;
        return jsonResult(payload);
      });
      registerPlugin({
        actions: { describeMessageTool: () => ({ actions: ["send"] }), handleAction },
      });

      const result = await runMessageAction({
        cfg: {},
        action: "broadcast",
        params: { channel, targets: ["room-1", "room-2"], message: "broadcast reply" },
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        skipQueue: true,
        suppressTranscriptMirror: true,
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw closed;
          }
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              to: "room-1",
              ok: accepted,
              payload,
              ...(accepted ? {} : { error: "provider result unknown", sentBeforeError: true }),
            },
            { to: "room-2", ok: false, attempted: false },
          ],
        },
      });
      expect(result).not.toHaveProperty("payload.results.0.attempted");
      expect(result).not.toHaveProperty("payload.results.0.payload.sourceReplyRoute");
      expect(resolveMessageActionOutcome(result).ok).toBe(false);
    },
  );

  it.each(["send", "poll", "set-presence"] as const)(
    "returns known partial %s facts to the caller with their failure outcome",
    async (action) => {
      const payload = {
        ok: false,
        deliveryStatus: "partial_failed",
        sentBeforeError: true,
        error: "second part failed",
        ...(action === "send"
          ? { messageId: "part-1" }
          : { result: { messageIds: ["part-1"], visibleReplySent: true } }),
      };
      let active = true;
      const handleAction = vi.fn(async () => {
        active = false;
        return jsonResult(payload);
      });
      registerPlugin({
        actions: {
          describeMessageTool: () => ({ actions: [action] }),
          handleAction,
        },
      });

      const result = await runMessageAction({
        cfg: {},
        action,
        params: {
          channel,
          ...(action === "set-presence" ? {} : { target: "room-1" }),
          message: "partial reply",
        },
        conversationReadOrigin: "direct-operator",
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        suppressTranscriptMirror: true,
        assertDirectAdapterHandoff: () => {
          if (!active) {
            throw closed;
          }
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(result.payload).toBe(payload);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
      expect(resolveMessageActionOutcome(result)).toEqual({
        ok: false,
        sentBeforeError: true,
        error: "second part failed",
      });
    },
  );

  it.each([
    "before lookup",
    "during lookup",
    "lookup failure",
    "aborted before lookup",
    "aborted during lookup",
  ] as const)("preserves an accepted thread reply (%s)", async (scenario) => {
    let active = true;
    const caller = new AbortController();
    const matchesCurrentConversationAsync = vi.fn(async () => {
      if (scenario === "lookup failure") {
        throw new Error("source lookup unavailable");
      }
      if (scenario === "during lookup") {
        active = false;
      }
      if (scenario === "aborted during lookup") {
        caller.abort(closed);
      }
      return true;
    });
    const handleAction = vi.fn(async () => {
      if (scenario === "before lookup") {
        active = false;
      }
      if (scenario === "aborted before lookup") {
        caller.abort(closed);
      }
      return jsonResult(acceptedPayload);
    });
    registerPlugin({
      actions: {
        describeMessageTool: () => ({ actions: ["thread-reply"] }),
        messageActionTargetAliases: {
          "thread-reply": { aliases: ["threadId"], matchesCurrentConversationAsync },
        },
        handleAction,
      },
    });

    const result = await runMessageAction({
      cfg: {},
      action: "thread-reply",
      params: { channel, target: "room-1", threadId: "thread-1", message: "accepted reply" },
      conversationReadOrigin: "direct-operator",
      messageActionAuthorization: authorization,
      sessionKey,
      defaultAccountId: "default",
      abortSignal: caller.signal,
      assertDirectAdapterHandoff: scenario.startsWith("aborted")
        ? undefined
        : () => {
            if (!active) {
              throw closed;
            }
          },
    });

    expect(handleAction).toHaveBeenCalledOnce();
    expect(matchesCurrentConversationAsync).toHaveBeenCalledTimes(
      scenario === "before lookup" || scenario === "aborted before lookup" ? 0 : 1,
    );
    expect(result.payload).toBe(acceptedPayload);
    expect(result).toHaveProperty("toolResult.details", acceptedPayload);
    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });

  it.each([
    { name: "unidentified", payload: {} },
    { name: "unconfirmed ID", payload: { messageId: "unconfirmed-1" } },
    { name: "unknown ID", payload: { ok: true, messageId: "unknown" } },
    { name: "rejected with an ID", payload: { ok: false, messageId: "rejected-1" } },
    {
      name: "conflicting partial status",
      payload: { ok: true, deliveryStatus: "partial_failed", messageId: "part-1" },
    },
    {
      name: "conflicting partial and dry-run status",
      payload: {
        ok: false,
        deliveryStatus: "partial_failed",
        status: "dry_run",
        sentBeforeError: true,
      },
    },
    { name: "tool partial delivery", payload: acceptedPayload, toolPartial: true },
    { name: "tool dry run", payload: acceptedPayload, toolDryRun: true },
    { name: "dry run", payload: acceptedPayload, dryRun: true },
    { name: "read", payload: acceptedPayload, action: "read" as const },
  ])("keeps $name strict when annotation loses authority", async (testCase) => {
    const plugin = registerPlugin();
    const result: MessageActionResult = {
      ...(testCase.action === "read"
        ? { kind: "action", action: "read" }
        : { kind: "send", action: "send", to: "room-1" }),
      channel,
      handledBy: "plugin",
      payload: testCase.payload,
      toolResult: {
        ...jsonResult(testCase.payload),
        ...(testCase.toolPartial ? { sentBeforeError: true } : {}),
        ...(testCase.toolDryRun ? { dryRun: true } : {}),
      },
      dryRun: testCase.dryRun ?? false,
    };
    const ctx: ResolvedActionContext = {
      cfg: {},
      params: { to: "room-1" },
      channel,
      channelPlugin: plugin,
      mediaAccess: { localRoots: [] },
      dryRun: result.dryRun,
      input: {
        cfg: {},
        action: result.action,
        params: {},
        messageActionAuthorization: authorization,
        assertDirectAdapterHandoff: () => {
          throw closed;
        },
      },
    };

    await expect(annotateSourceDelivery(result, ctx, false)).rejects.toBe(closed);
    expect(result.payload).toBe(testCase.payload);
    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});

const threadActionParams = {
  action: "thread-reply",
  to: "direct:user-1",
  threadId: "thread-1",
  message: "visible reply",
};

const input = {
  cfg: {},
  action: "thread-reply" as const,
  params: { channel: "testchat", ...threadActionParams },
  messageActionAuthorization: {
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "testchat" as const,
      currentChannelId: "direct:user-1",
      currentThreadTs: "thread-1",
    },
  },
  sessionKey: "agent:main:testchat:direct:user-1",
  defaultAccountId: "default",
};

const annotationParams = {
  cfg: {},
  params: threadActionParams,
  channel: "testchat" as const,
  accountId: "default",
  input,
  dryRun: false,
  channelPlugin: createChannelTestPluginBase({ id: "testchat" }),
  mediaAccess: { localRoots: [] },
};

describe("annotateSourceDelivery thread replies", () => {
  afterEach(() => resetPluginRuntimeStateForTest());
  it.each([true, false, "error", "stale"] as const)(
    "awaits owner proof for a receiptless thread reply without legacy fallback (%s)",
    async (outcome) => {
      const proof = createDeferred<boolean>();
      const matchesCurrentConversation = vi.fn(() => true);
      const matchesCurrentConversationAsync = vi.fn(() => proof.promise);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "testchat",
            source: "test",
            origin: "bundled",
            plugin: {
              ...annotationParams.channelPlugin,
              actions: {
                describeMessageTool: () => ({ actions: ["thread-reply"] }),
                messageActionTargetAliases: {
                  "thread-reply": {
                    aliases: ["threadId"],
                    matchesCurrentConversation,
                    matchesCurrentConversationAsync,
                  },
                },
              },
            },
          },
        ]),
      );
      const actionResult = {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { ok: true },
        dryRun: false,
      };
      const pending = annotateSourceDelivery(actionResult, annotationParams, false);
      expect(matchesCurrentConversationAsync).toHaveBeenCalledOnce();
      expect(matchesCurrentConversation).not.toHaveBeenCalled();
      if (outcome === "error") {
        const expected = expect(pending).rejects.toThrow("proof unavailable");
        proof.reject(new Error("proof unavailable"));
        await expected;
      } else {
        if (outcome === "stale") {
          setActivePluginRegistry(createTestRegistry([]));
        }
        proof.resolve(outcome !== false);
        const result = await pending;
        if (outcome === true) {
          expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
        } else {
          expect(result).toBe(actionResult);
        }
      }
      expect(matchesCurrentConversation).not.toHaveBeenCalled();
    },
  );

  it("marks both payload and tool details after local plugin dispatch", async () => {
    const receipt = { threadId: "thread-1" };
    const result = await annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt },
        toolResult: {
          content: [{ type: "text" as const, text: "delivered" }],
          details: { receipt },
        },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    expect(result.toolResult.details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves a different-thread receipt unmarked", async () => {
    const result = await annotateSourceDelivery(
      {
        kind: "action" as const,
        channel: "testchat" as const,
        action: "thread-reply" as const,
        handledBy: "plugin" as const,
        payload: { receipt: { threadId: "other-thread" } },
        dryRun: false,
      },
      annotationParams,
      false,
    );

    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});

describe("runMessageAction reply-type plugin actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });
  it("marks replies to the run's inbound message as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: "1783" },
      currentMessageId: "1783",
    });

    expect(result.kind).toBe("action");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    const details = "toolResult" in result ? result.toolResult?.details : undefined;
    expect(details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("matches numeric replied-to message ids against string tool-context ids", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: 1783 },
      currentMessageId: "1783",
    });

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves explicitly targeted replies unmarked", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: {
        message: "visible reply",
        messageId: "1783",
        to: "direct:someone-else",
      },
      currentMessageId: "1783",
    });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("marks polls sent to the current conversation as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runCurrentConversationPollAction({ to: "direct:user-1" });

    expect(result.kind).toBe("poll");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves polls sent to other conversations unmarked", async () => {
    registerReplyPlugin();

    const result = await runCurrentConversationPollAction({ to: "direct:someone-else" });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});

const pollerConfig = {
  channels: {
    poller: {
      botToken: "poller-test",
    },
  },
} as OpenClawConfig;

type PollerSendPoll = NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendPoll"]>;

const sendPoll = async ({ threadId }: Parameters<PollerSendPoll>[0]) => ({
  messageId: "poll-test",
  receipt: createMessageReceiptFromOutboundResults({
    results: [{ messageId: "poll-test" }],
    kind: "poll",
    ...(threadId ? { threadId } : {}),
    sentAt: 1,
  }),
});
const pollerSendPoll = vi.fn<PollerSendPoll>(sendPoll);

const pollerTestPlugin: ChannelPlugin = {
  id: "poller",
  meta: {
    id: "poller",
    label: "Poller",
    selectionLabel: "Poller",
    docsPath: "/channels/poller",
    blurb: "Poller test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "poller-test" }),
    isConfigured: () => true,
  },
  outbound: {
    deliveryMode: "direct",
    sendPoll: pollerSendPoll,
  },
  actions: {
    describeMessageTool: () => null,
    supportsAction: ({ action }) => action !== "poll",
    handleAction: async () => {
      throw new Error("poll should be owned by the canonical adapter");
    },
  },
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        to: normalized,
        kind: "user",
        source: "normalized",
      }),
    },
  },
  threading: {
    resolveAutoThreadId: ({ toolContext, to, replyToId }) => {
      if (replyToId || toolContext?.currentChannelId !== to) {
        return undefined;
      }
      return toolContext.currentThreadTs;
    },
  },
};

async function runPollAction(params: {
  actionParams: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}) {
  const target = params.actionParams.target;
  if (typeof target !== "string") {
    throw new Error("poll test target is required");
  }
  const actionParams = { ...params.actionParams, to: target };
  const result = await executeMessagePoll({
    cfg: pollerConfig,
    params: actionParams,
    channel: "poller",
    channelPlugin: pollerTestPlugin,
    mediaAccess: {},
    accountId: "default",
    dryRun: false,
    input: {
      cfg: pollerConfig,
      action: "poll",
      params: actionParams,
      toolContext: params.toolContext,
    },
  });
  if (result.kind !== "poll") {
    throw new Error(`expected poll result, got ${result.kind}`);
  }
  const call = pollerSendPoll.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected poller sendPoll call");
  }
  return { call, result };
}

describe("executeMessagePoll", () => {
  beforeAll(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "poller", source: "test", plugin: pollerTestPlugin }]),
    );
  });

  beforeEach(() => {
    pollerSendPoll.mockReset();
    pollerSendPoll.mockImplementation(sendPoll);
  });

  afterAll(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("passes normalized poll fields and auto threadId to the provider", async () => {
    const { call, result } = await runPollAction({
      actionParams: {
        target: "poller:123",
        message: "    Choose carefully  ",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationHours: 2,
        silent: true,
      },
      toolContext: {
        currentChannelId: "poller:123",
        currentThreadTs: "42",
      },
    });

    expect(call.poll).toMatchObject({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      durationHours: 2,
      maxSelections: 1,
    });
    expect(call.threadId).toBe("42");
    expect(call.content).toBe("    Choose carefully  ");
    expect(call.silent).toBe(true);
    expect(pollerSendPoll).toHaveBeenCalledOnce();
    expect(result.pollResult?.result).toMatchObject({
      messageId: "poll-test",
      receipt: { primaryPlatformMessageId: "poll-test", threadId: "42" },
    });
  });

  it("normalizes blank poll content and trims its question and options", async () => {
    const { call } = await runPollAction({
      actionParams: {
        target: "poller:123",
        message: " \n\t ",
        pollQuestion: " Lunch? ",
        pollOption: [" Pizza ", " Sushi "],
      },
    });
    expect(call.content).toBe("");
    expect(call.poll.question).toBe("Lunch?");
    expect(call.poll.options).toEqual(["Pizza", "Sushi"]);
  });

  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        actionParams: {
          target: "poller:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza"],
        },
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
  });
});
