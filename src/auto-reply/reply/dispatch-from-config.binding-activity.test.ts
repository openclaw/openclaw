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

describe("dispatch binding activity settlement", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    abortMessage.mockClear();
  });

  it.each([
    { mode: "plugin claim", fail: false, aborted: false, stoppedSubagents: 0 },
    { mode: "plugin claim", fail: true, aborted: false, stoppedSubagents: 0 },
    { mode: "fast abort", fail: false, aborted: true, stoppedSubagents: 0 },
    { mode: "fast abort", fail: true, aborted: true, stoppedSubagents: 0 },
    { mode: "fast abort", fail: true, aborted: false, stoppedSubagents: 1 },
    { mode: "fast abort", fail: true, aborted: false, stoppedSubagents: 0 },
  ])(
    "awaits binding activity before $mode (failure: $fail, aborted: $aborted, stopped: $stoppedSubagents)",
    async ({ mode, fail, aborted, stoppedSubagents }) => {
      setNoAbort();
      mockPluginBindingClaim();
      const binding = pluginBinding("binding-await-activity", "activity");
      const lookup = createDispatchGate<typeof binding>();
      rejectSyncBindingRead();
      readBinding.mockResolvedValue(binding).mockImplementationOnce(lookup.wait);
      if (mode === "fast abort") {
        abortMessage.mockResolvedValue({
          handled: true,
          aborted,
          stoppedSubagents,
        });
      }
      const mutation = createDispatchGate();
      touch.mockImplementationOnce(mutation.wait);
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "should not run" }));
      const params = {
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          To: "channel:activity",
          Body: mode === "fast abort" ? "/stop" : "hello",
          SessionKey: "agent:main:discord:channel:activity",
          MessageSid: "binding-activity-message",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      };
      const dispatch = dispatchReplyFromConfig(params);
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
    { owner: "ACP", change: "bindingId", outcome: "complete" },
    { owner: "ACP", change: "bindingId", outcome: "fail" },
    { owner: "ACP", change: "bindingId", outcome: "replace-again" },
    { owner: "ACP", change: "boundAt", outcome: "complete" },
    { owner: "ACP", change: "targetSessionKey", outcome: "complete" },
    { owner: "ACP", change: "targetKind", outcome: "complete" },
    { owner: "plugin", change: "bindingId", outcome: "complete" },
    { owner: "plugin", change: "targetSessionKey", outcome: "complete" },
    { owner: "plugin", change: "boundAt", outcome: "complete" },
    { owner: "plugin", change: "targetKind", outcome: "complete" },
  ] as const)(
    "settles replacement $owner ownership after $change changes: $outcome",
    async ({ owner, change, outcome }) => {
      const plugin = owner === "plugin";
      if (plugin) {
        setNoAbort();
        mockPluginBindingClaim();
      } else {
        abortMessage.mockResolvedValue({ handled: true, aborted: false });
      }
      const original: SessionBindingRecord = plugin
        ? pluginBinding("binding-owner-before", "before")
        : {
            bindingId: "binding-acp-before",
            targetSessionKey: "agent:main:acp:before",
            targetKind: "session",
            status: "active",
            boundAt: 1,
            conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
          };
      const replacement: SessionBindingRecord = {
        ...original,
        bindingId: change === "bindingId" ? "binding-owner-after" : original.bindingId,
        boundAt: change === "boundAt" ? original.boundAt + 1 : original.boundAt,
        targetSessionKey:
          change === "targetSessionKey" || (plugin && change === "bindingId")
            ? plugin
              ? "plugin-binding:test:after"
              : "agent:main:acp:after"
            : original.targetSessionKey,
        targetKind: change === "targetKind" ? "subagent" : original.targetKind,
      };
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
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn();
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          To: plugin ? "channel:activity" : "discord:C123",
          SessionKey: plugin ? "agent:main:discord:channel:activity" : "agent:main:discord:C123",
          ...(plugin ? { Body: "hello" } : {}),
        }),
        cfg: emptyConfig,
        dispatcher,
        ...(plugin ? {} : { replyResolver }),
      });
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
      const failure =
        outcome === "complete"
          ? undefined
          : expect(dispatch).rejects.toThrow(
              outcome === "fail"
                ? "replacement activity failed"
                : "conversation binding changed while recording activity",
            );
      if (outcome === "fail") {
        replacementActivity.reject(new Error("replacement activity failed"));
      } else {
        if (outcome === "replace-again") {
          current = { ...replacement, bindingId: "binding-acp-third" };
        }
        replacementActivity.resolve();
      }
      if (failure) {
        await failure;
        expectNotCalled(abortMessage, dispatcher.sendFinalReply);
      } else {
        await dispatch;
        if (plugin) {
          expect(claim).toHaveBeenCalledExactlyOnceWith(
            "openclaw-codex-app-server",
            expect.anything(),
            expect.objectContaining({
              pluginBinding: expect.objectContaining({
                bindingId: current.bindingId,
                boundAt: current.boundAt,
              }),
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
  const binding: SessionBindingRecord = {
    bindingId: "route-before",
    targetSessionKey: "agent:main:acp:before",
    targetKind: "session",
    status: "active",
    boundAt: 1,
    conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
  };

  function prepareContext(bound = true, threadId?: string) {
    const baseRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: bound ? "agent:main:discord:C123" : binding.targetSessionKey,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    };
    const { route } = inspectRuntimeConversationBindingRoute({
      route: baseRoute,
      inspection: { status: "available", binding: bound ? binding : null },
    });
    const finalizedRoute = threadId
      ? { ...route, sessionKey: `${route.sessionKey}:thread:${threadId}` }
      : route;
    // Bundled channels carry route facts into the shared builder; finalization and
    // dispatch also accept copies of the finalized context.
    return {
      ...buildChannelInboundEventContext({
        channel: "discord",
        accountId: "default",
        from: "discord:user:U1",
        sender: { id: "U1" },
        conversation: { kind: "channel", id: "C123" },
        route: { ...finalizedRoute, routeSessionKey: finalizedRoute.sessionKey },
        reply: { to: "discord:C123", messageThreadId: threadId },
        message: { rawBody: "continue the work" },
      }),
    };
  }

  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        backend: "acpx",
        agent: "main",
        runtimeSessionName: "runtime:route",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
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
      const ctx = prepareContext();
      const runtime = createAcpRuntime([{ type: "done" }]);
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      let current: SessionBindingRecord | null = binding;
      const activity = createDispatchGate();
      readBinding.mockImplementation(async () => current);
      if (phase === "initial read") {
        readBinding.mockImplementationOnce(async () => {
          await activity.wait();
          return current;
        });
      } else {
        touch.mockImplementationOnce(async () => {
          await activity.wait();
        });
      }
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn();
      const dispatch = dispatchReplyFromConfig({
        ctx,
        cfg: { acp: { enabled: true, dispatch: { enabled: true } } },
        dispatcher,
        replyResolver,
      });
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
      const runtime = createAcpRuntime([{ type: "done" }]);
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      readBinding.mockImplementation(async (ref) =>
        bound && ref.conversationId === binding.conversation.conversationId ? binding : null,
      );
      await dispatchReplyFromConfig({
        ctx: prepareContext(bound, threadId),
        cfg: { acp: { enabled: true, dispatch: { enabled: true } } },
        dispatcher: createDispatcher(),
      });
      expect(runtime.runTurn).toHaveBeenCalledOnce();
      expect(runtime.runTurn.mock.calls[0]?.[0].handle.sessionKey).toBe(target);
    },
  );
});
