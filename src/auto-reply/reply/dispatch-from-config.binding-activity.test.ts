import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { inspectRuntimeConversationBindingRoute } from "../../channels/plugins/binding-routing.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { createPluginBindingRecord } from "./conversation-binding.test-fixtures.js";
import {
  acpMocks,
  createDispatcher,
  emptyConfig,
  hookMocks,
  mockPluginBindingClaim,
  mocks,
  sessionBindingMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createAcpRuntime,
  createDispatchGate,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const readBinding = sessionBindingMocks.resolveByConversationAsync;
const readBindingSync = sessionBindingMocks.resolveByConversation;
const touch = sessionBindingMocks.touch;
const claim = hookMocks.runner.runInboundClaimForPluginOutcome;
const received = hookMocks.runner.runMessageReceived;
const abortMessage = mocks.tryFastAbortFromMessage;
const failedActivity = "replacement activity failed";
const changedActivity = "conversation binding changed while recording activity";

beforeAll(globalBeforeAll0);

const activityConversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "channel:activity",
};

function pluginBinding(bindingId: string, target: string, conversation = activityConversation) {
  return createPluginBindingRecord({
    bindingId,
    targetSessionKey: `plugin-binding:test:${target}`,
    conversation,
    pluginRoot: "/tmp/test-plugin",
  });
}

function rejectSyncBindingRead() {
  readBindingSync.mockImplementation(() => {
    throw new Error("dispatch must await binding reads");
  });
}

function expectNotCalled(...callbacks: Array<{ mock: { calls: unknown[] } }>) {
  for (const callback of callbacks) {
    expect(callback).not.toHaveBeenCalled();
  }
}

function acpBinding(bindingId: string): SessionBindingRecord {
  return {
    bindingId,
    targetSessionKey: "agent:main:acp:before",
    targetKind: "session",
    status: "active",
    boundAt: 1,
    conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
  };
}

function dispatchCase(
  ctx: Parameters<typeof dispatchReplyFromConfig>[0]["ctx"],
  cfg = emptyConfig,
  includeResolver = true,
) {
  const dispatcher = createDispatcher();
  const replyResolver = vi.fn();
  const params = { ctx, cfg, dispatcher, ...(includeResolver ? { replyResolver } : {}) };
  return { params, dispatcher, replyResolver, dispatch: dispatchReplyFromConfig(params) };
}

function discordContext(To: string, Body = "") {
  const SessionKey = `agent:main:discord:${To.replace(/^discord:/, "")}`;
  return buildTestCtx({ Provider: "discord", Surface: "discord", To, Body, SessionKey });
}

describe("dispatch binding activity settlement", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    abortMessage.mockClear();
  });

  it.each([
    ["plugin claim", false, false, 0],
    ["plugin claim", true, false, 0],
    ["fast abort", false, true, 0],
    ["fast abort", true, true, 0],
    ["fast abort", true, false, 1],
    ["fast abort", true, false, 0],
  ] as const)(
    "awaits binding activity before %s (failure: %s, aborted: %s, stopped: %s)",
    async (mode, fail, aborted, stoppedSubagents) => {
      setNoAbort();
      mockPluginBindingClaim();
      const binding = pluginBinding("binding-await-activity", "activity");
      const lookup = createDispatchGate<typeof binding>();
      rejectSyncBindingRead();
      readBinding.mockResolvedValue(binding).mockImplementationOnce(lookup.wait);
      if (mode === "fast abort") {
        abortMessage.mockResolvedValue({ handled: true, aborted, stoppedSubagents });
      }
      const mutation = createDispatchGate();
      touch.mockImplementationOnce(mutation.wait);
      const { params, dispatcher, replyResolver, dispatch } = dispatchCase({
        ...discordContext("channel:activity", mode === "fast abort" ? "/stop" : "hello"),
        MessageSid: "binding-activity-message",
      });
      await Promise.race([lookup.started, dispatch]);
      expectNotCalled(touch, claim, received, dispatcher.sendFinalReply);
      lookup.resolve(binding);
      await mutation.started;
      expectNotCalled(claim, received, dispatcher.sendFinalReply);
      if (fail) {
        const failure = expect(dispatch).rejects.toThrow("activity persistence failed");
        mutation.reject(new Error("activity persistence failed"));
        await failure;
        expectNotCalled(claim, dispatcher.sendFinalReply);
        if (mode === "fast abort") {
          await dispatchReplyFromConfig(params);
          expect(abortMessage).toHaveBeenCalledTimes(aborted || stoppedSubagents > 0 ? 1 : 2);
        }
      } else {
        mutation.resolve();
        await dispatch;
        if (mode === "plugin claim") {
          expect(claim).toHaveBeenCalledOnce();
        } else {
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "⚙️ Agent was aborted." });
        }
      }
      expect(replyResolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ACP", "bindingId", ""],
    ["ACP", "bindingId", failedActivity],
    ["ACP", "bindingId", changedActivity],
    ["ACP", "boundAt", ""],
    ["ACP", "targetSessionKey", ""],
    ["ACP", "targetKind", ""],
    ["plugin", "bindingId", ""],
    ["plugin", "targetSessionKey", ""],
    ["plugin", "boundAt", ""],
    ["plugin", "targetKind", ""],
  ] as const)(
    "settles replacement %s ownership after %s changes: %s",
    async (owner, change, failure) => {
      const plugin = owner === "plugin";
      if (plugin) {
        setNoAbort();
        mockPluginBindingClaim();
      } else {
        abortMessage.mockResolvedValue({ handled: true, aborted: false });
      }
      const original: SessionBindingRecord = plugin
        ? pluginBinding("binding-owner-before", "before")
        : acpBinding("binding-acp-before");
      const changes = {
        bindingId: "binding-owner-after",
        boundAt: original.boundAt + 1,
        targetSessionKey: plugin ? "plugin-binding:test:after" : "agent:main:acp:after",
        targetKind: "subagent",
      } as const;
      const replacement = { ...original, [change]: changes[change] };
      if (plugin && change === "bindingId") {
        replacement.targetSessionKey = changes.targetSessionKey;
      }
      let current = original;
      if (!plugin) {
        rejectSyncBindingRead();
      }
      readBinding.mockImplementation(async () => current);
      const firstActivity = createDispatchGate();
      const replacementActivity = createDispatchGate();
      touch
        .mockImplementationOnce(firstActivity.wait)
        .mockImplementationOnce(replacementActivity.wait);
      const { dispatcher, replyResolver, dispatch } = dispatchCase(
        discordContext(plugin ? "channel:activity" : "discord:C123", plugin ? "hello" : ""),
        emptyConfig,
        !plugin,
      );
      const rejected = failure ? expect(dispatch).rejects.toThrow(failure) : undefined;
      await Promise.race([firstActivity.started, dispatch]);
      current = replacement;
      firstActivity.resolve();
      await Promise.race([replacementActivity.started, dispatch]);
      expect(touch).toHaveBeenCalledTimes(2);
      if (plugin) {
        expect(claim).not.toHaveBeenCalled();
      } else {
        expect(touch).toHaveBeenLastCalledWith(
          replacement.bindingId,
          undefined,
          replacement.conversation,
        );
        expectNotCalled(abortMessage, dispatcher.sendFinalReply);
      }
      if (failure === failedActivity) {
        replacementActivity.reject(new Error(failure));
      } else {
        if (failure === changedActivity) {
          current = { ...replacement, bindingId: "binding-acp-third" };
        }
        replacementActivity.resolve();
      }
      if (rejected) {
        await rejected;
        expectNotCalled(abortMessage, dispatcher.sendFinalReply);
      } else {
        await dispatch;
        if (plugin) {
          const { bindingId, boundAt } = current;
          expect(claim).toHaveBeenCalledExactlyOnceWith(
            "openclaw-codex-app-server",
            expect.anything(),
            expect.objectContaining({
              pluginBinding: expect.objectContaining({ bindingId, boundAt }),
            }),
          );
        } else {
          expect(abortMessage).toHaveBeenCalledOnce();
          expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
        }
      }
      expect(touch).toHaveBeenCalledTimes(2);
      if (!plugin) {
        expect(replyResolver).not.toHaveBeenCalled();
      }
    },
  );
});

describe("channel-derived ACP route admission", () => {
  const binding = acpBinding("route-before");
  const cfg = { acp: { enabled: true, dispatch: { enabled: true } } };
  function acpCase(ctx: Parameters<typeof dispatchCase>[0], includeResolver = true) {
    const runtime = createAcpRuntime([{ type: "done" }]);
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
    return { runtime, ...dispatchCase(ctx, cfg, includeResolver) };
  }

  function prepareContext(bound = true, threadId?: string) {
    const { route } = inspectRuntimeConversationBindingRoute({
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: bound ? "agent:main:discord:C123" : binding.targetSessionKey,
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session" as const,
        matchedBy: "default" as const,
      },
      inspection: { status: "available", binding: bound ? binding : null },
    });
    const sessionKey = threadId ? `${route.sessionKey}:thread:${threadId}` : route.sessionKey;
    // Exercise channel route facts through a copied, finalized inbound context.
    return {
      ...buildChannelInboundEventContext({
        channel: "discord",
        accountId: "default",
        from: "discord:user:U1",
        sender: { id: "U1" },
        conversation: { kind: "channel", id: "C123" },
        route: { ...route, sessionKey, routeSessionKey: sessionKey },
        reply: { to: "discord:C123", messageThreadId: threadId },
        message: { rawBody: "continue the work" },
      }),
    };
  }

  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: { agent: "main", runtimeSessionName: "runtime:route" },
    });
  });

  it.each([
    { change: "removed", phase: "initial read" },
    { change: "removed", phase: "activity" },
    { change: "plugin", phase: "activity" },
    { change: "plugin-metadata", phase: "activity" },
    { change: "target", phase: "activity" },
    { change: "incarnation", phase: "activity" },
  ] as const)(
    "rejects $change binding during $phase before dispatching the prepared target",
    async ({ change, phase }) => {
      let current: SessionBindingRecord | null = binding;
      const activity = createDispatchGate();
      readBinding.mockImplementation(async () => current);
      if (phase === "initial read") {
        readBinding.mockImplementationOnce(async () => {
          await activity.wait();
          return current;
        });
      } else {
        touch.mockImplementationOnce(activity.wait);
      }
      const { runtime, dispatcher, replyResolver, dispatch } = acpCase(prepareContext());
      // Attach settlement immediately so an intended rejection never becomes unhandled.
      const result = dispatch.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([activity.started, result]);
      current =
        change === "removed"
          ? null
          : change === "plugin" || change === "plugin-metadata"
            ? pluginBinding("route-plugin", "replacement", binding.conversation)
            : {
                ...binding,
                boundAt: change === "incarnation" ? 2 : binding.boundAt,
                targetSessionKey:
                  change === "target" ? "agent:main:acp:after" : binding.targetSessionKey,
              };
      if (change === "plugin-metadata" && current) {
        current = { ...binding, metadata: current.metadata };
      }
      activity.resolve();
      expect((await result).error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expectNotCalled(runtime.runTurn, claim, replyResolver, dispatcher.sendFinalReply);
    },
  );

  it.each([
    { bound: false, threadId: undefined, target: binding.targetSessionKey },
    { bound: true, threadId: "1234:42", target: `${binding.targetSessionKey}:thread:1234:42` },
  ])(
    "preserves the prepared ACP target (bound: $bound, thread: $threadId)",
    async ({ bound, threadId, target }) => {
      readBinding.mockImplementation(async (ref) =>
        bound && ref.conversationId === binding.conversation.conversationId ? binding : null,
      );
      const { runtime, dispatch } = acpCase(prepareContext(bound, threadId), false);
      await dispatch;
      expect(runtime.runTurn).toHaveBeenCalledOnce();
      expect(runtime.runTurn.mock.calls[0]?.[0].handle.sessionKey).toBe(target);
    },
  );
});
