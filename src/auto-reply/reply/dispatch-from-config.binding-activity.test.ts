import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatch binding activity settlement", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    mocks.tryFastAbortFromMessage.mockClear();
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
      const binding = createPluginBindingRecord({
        bindingId: "binding-await-activity",
        targetSessionKey: "plugin-binding:test:activity",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:activity",
        },
        pluginRoot: "/tmp/test-plugin",
      });
      const lookup = createDeferred<typeof binding>();
      const lookupStarted = createDeferred();
      sessionBindingMocks.resolveByConversation.mockImplementation(() => {
        throw new Error("dispatch must await binding reads");
      });
      sessionBindingMocks.resolveByConversationAsync
        .mockResolvedValue(binding)
        .mockImplementationOnce(() => {
          lookupStarted.resolve();
          return lookup.promise;
        });
      if (mode === "fast abort") {
        mocks.tryFastAbortFromMessage.mockResolvedValue({
          handled: true,
          aborted,
          stoppedSubagents,
        });
      }
      const mutation = createDeferred();
      const started = createDeferred();
      sessionBindingMocks.touch.mockImplementationOnce(() => {
        started.resolve();
        return mutation.promise;
      });
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
      await Promise.race([lookupStarted.promise, dispatch]);
      expect(sessionBindingMocks.touch).not.toHaveBeenCalled();
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
      expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      lookup.resolve(binding);
      await started.promise;
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
      expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      if (fail) {
        const failure = expect(dispatch).rejects.toThrow("activity persistence failed");
        mutation.reject(new Error("activity persistence failed"));
        await failure;
        expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        if (mode === "fast abort") {
          await dispatchReplyFromConfig(params);
          expect(mocks.tryFastAbortFromMessage).toHaveBeenCalledTimes(
            aborted || stoppedSubagents > 0 ? 1 : 2,
          );
        }
      } else {
        mutation.resolve();
        await dispatch;
        if (mode === "plugin claim") {
          expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledOnce();
        } else {
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "⚙️ Agent was aborted." });
        }
      }
      expect(replyResolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    { change: "bindingId", outcome: "complete" },
    { change: "bindingId", outcome: "fail" },
    { change: "bindingId", outcome: "replace-again" },
    { change: "boundAt", outcome: "complete" },
    { change: "targetSessionKey", outcome: "complete" },
    { change: "targetKind", outcome: "complete" },
  ] as const)(
    "settles a replacement ACP binding after $change changes: $outcome",
    async ({ change, outcome }) => {
      mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: true, aborted: false });
      const original: SessionBindingRecord = {
        bindingId: "binding-acp-before",
        targetSessionKey: "agent:main:acp:before",
        targetKind: "session",
        status: "active",
        boundAt: 1,
        conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
      };
      const replacement: SessionBindingRecord = {
        ...original,
        bindingId: change === "bindingId" ? "binding-acp-after" : original.bindingId,
        boundAt: change === "boundAt" ? 2 : original.boundAt,
        targetSessionKey:
          change === "targetSessionKey" ? "agent:main:acp:after" : original.targetSessionKey,
        targetKind: change === "targetKind" ? "subagent" : original.targetKind,
      };
      let current = original;
      sessionBindingMocks.resolveByConversation.mockImplementation(() => {
        throw new Error("dispatch must await binding reads");
      });
      sessionBindingMocks.resolveByConversationAsync.mockImplementation(async () => current);
      const firstActivity = createDeferred();
      const firstStarted = createDeferred();
      const replacementActivity = createDeferred();
      const replacementStarted = createDeferred();
      sessionBindingMocks.touch
        .mockImplementationOnce(() => {
          firstStarted.resolve();
          return firstActivity.promise;
        })
        .mockImplementationOnce(() => {
          replacementStarted.resolve();
          return replacementActivity.promise;
        });
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn();
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          To: "discord:C123",
          SessionKey: "agent:main:discord:C123",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });
      await Promise.race([firstStarted.promise, dispatch]);
      current = replacement;
      firstActivity.resolve();
      await Promise.race([replacementStarted.promise, dispatch]);
      expect(sessionBindingMocks.touch).toHaveBeenCalledTimes(2);
      expect(sessionBindingMocks.touch).toHaveBeenLastCalledWith(
        replacement.bindingId,
        undefined,
        replacement.conversation,
      );
      expect(mocks.tryFastAbortFromMessage).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
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
        expect(mocks.tryFastAbortFromMessage).not.toHaveBeenCalled();
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      } else {
        await dispatch;
        expect(mocks.tryFastAbortFromMessage).toHaveBeenCalledOnce();
        expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      }
      expect(sessionBindingMocks.touch).toHaveBeenCalledTimes(2);
      expect(replyResolver).not.toHaveBeenCalled();
    },
  );

  it.each(["bindingId", "targetSessionKey", "boundAt", "targetKind"] as const)(
    "refreshes plugin ownership when %s changes while activity is pending",
    async (change) => {
      setNoAbort();
      mockPluginBindingClaim();
      const original = createPluginBindingRecord({
        bindingId: "binding-owner-before",
        targetSessionKey: "plugin-binding:test:before",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:activity",
        },
        pluginRoot: "/tmp/test-plugin",
      });
      let current = original;
      sessionBindingMocks.resolveByConversationAsync.mockImplementation(async () => current);
      const mutation = createDeferred();
      const started = createDeferred();
      const replacementMutation = createDeferred();
      const replacementStarted = createDeferred();
      sessionBindingMocks.touch
        .mockImplementationOnce(() => {
          started.resolve();
          return mutation.promise;
        })
        .mockImplementationOnce(() => {
          replacementStarted.resolve();
          return replacementMutation.promise;
        });
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          To: "channel:activity",
          Body: "hello",
          SessionKey: "agent:main:discord:channel:activity",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
      });
      await started.promise;
      current = {
        ...original,
        bindingId: change === "bindingId" ? "binding-owner-after" : original.bindingId,
        targetSessionKey:
          change === "bindingId" || change === "targetSessionKey"
            ? "plugin-binding:test:after"
            : original.targetSessionKey,
        boundAt: change === "boundAt" ? original.boundAt + 1 : original.boundAt,
        targetKind: change === "targetKind" ? "subagent" : original.targetKind,
      };
      mutation.resolve();
      await Promise.race([replacementStarted.promise, dispatch]);
      expect(sessionBindingMocks.touch).toHaveBeenCalledTimes(2);
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
      replacementMutation.resolve();
      await dispatch;
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledExactlyOnceWith(
        "openclaw-codex-app-server",
        expect.anything(),
        expect.objectContaining({
          pluginBinding: expect.objectContaining({
            bindingId: current.bindingId,
            boundAt: current.boundAt,
          }),
        }),
      );
      expect(sessionBindingMocks.touch).toHaveBeenCalledTimes(2);
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
      const started = createDeferred();
      const release = createDeferred();
      sessionBindingMocks.resolveByConversationAsync.mockImplementation(async () => current);
      if (phase === "initial read") {
        sessionBindingMocks.resolveByConversationAsync.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
          return current;
        });
      } else {
        sessionBindingMocks.touch.mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
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
      await Promise.race([started.promise, result]);
      current =
        change === "removed"
          ? null
          : change === "plugin" || change === "plugin-metadata"
            ? createPluginBindingRecord({
                bindingId: "route-plugin",
                targetSessionKey: "plugin-binding:test:replacement",
                conversation: binding.conversation,
                pluginRoot: "/tmp/test-plugin",
              })
            : {
                ...binding,
                boundAt: change === "incarnation" ? 2 : binding.boundAt,
                targetSessionKey:
                  change === "target" ? "agent:main:acp:after" : binding.targetSessionKey,
              };
      if (change === "plugin-metadata" && current) {
        current = { ...binding, metadata: current.metadata };
      }
      release.resolve();
      expect((await result).error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(runtime.runTurn).not.toHaveBeenCalled();
      expect(hookMocks.runner.runInboundClaimForPluginOutcome).not.toHaveBeenCalled();
      expect(replyResolver).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit direct ACP target without a runtime binding", async () => {
    const runtime = createAcpRuntime([{ type: "done" }]);
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
    sessionBindingMocks.resolveByConversationAsync.mockResolvedValue(null);
    await dispatchReplyFromConfig({
      ctx: prepareContext(false),
      cfg: { acp: { enabled: true, dispatch: { enabled: true } } },
      dispatcher: createDispatcher(),
    });
    expect(runtime.runTurn).toHaveBeenCalledOnce();
    expect(runtime.runTurn.mock.calls[0]?.[0].handle.sessionKey).toBe(binding.targetSessionKey);
  });
  it("preserves the prepared thread target while revalidating its parent binding", async () => {
    const ctx = prepareContext(true, "1234:42");
    const runtime = createAcpRuntime([{ type: "done" }]);
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
    sessionBindingMocks.resolveByConversationAsync.mockImplementation(async (ref) =>
      ref.conversationId === binding.conversation.conversationId ? binding : null,
    );
    await dispatchReplyFromConfig({
      ctx,
      cfg: { acp: { enabled: true, dispatch: { enabled: true } } },
      dispatcher: createDispatcher(),
    });
    expect(runtime.runTurn).toHaveBeenCalledOnce();
    expect(runtime.runTurn.mock.calls[0]?.[0].handle.sessionKey).toBe(
      `${binding.targetSessionKey}:thread:1234:42`,
    );
  });
});
