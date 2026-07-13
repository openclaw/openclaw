import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunTesting: typeof import("./reply-run-registry.js").__testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

describe("dispatchReplyFromConfig stale visible admission recovery", () => {
  beforeEach(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation, __testing: replyRunTesting } =
      await import("./reply-run-registry.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    runtimePluginMocks.ensureRuntimePluginsLoaded.mockReset();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    setNoAbort();
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockReset();
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockResolvedValue({
      status: "skipped",
      action: "keep_lane",
      reason: "active_reply_work",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("recovers stale visible reply work and retries dispatch admission", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:1";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockImplementationOnce(async () => {
      activeOperation.fail("run_failed", new Error("stale reply operation"));
      return {
        status: "aborted",
        action: "abort_embedded_run",
        sessionId: "active-session",
        sessionKey,
        activeSessionId: "active-session",
        activeWorkKind: "embedded_run",
        aborted: true,
        drained: true,
        forceCleared: false,
        released: 0,
      };
    });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "active-session",
        sessionKey,
        queueDepth: 1,
        staleActiveProgressAbortMs: 1_000,
      }),
    );
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("reclaims a pure stale reply registry lock when recovery finds no active work", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:pure-stale-registry";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockResolvedValue({
      status: "noop",
      action: "none",
      reason: "no_active_work",
      sessionId: "active-session",
      sessionKey,
    });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(activeOperation.result).toMatchObject({
      kind: "failed",
      code: "run_failed",
    });
  });

  it("does not clear a fresh reply operation with the same session id after recovery", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:fresh-same-session";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    let freshOperation: ReturnType<typeof createReplyOperation> | undefined;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery
      .mockImplementationOnce(async () => {
        activeOperation.complete();
        freshOperation = createReplyOperation({
          sessionKey,
          sessionId: "active-session",
          resetTriggered: false,
        });
        freshOperation.setPhase("running");
        return {
          status: "noop",
          action: "none",
          reason: "no_active_work",
          sessionId: "active-session",
          sessionKey,
        };
      })
      .mockImplementationOnce(async () => {
        freshOperation?.fail("run_failed", new Error("fresh operation later became stale"));
        return {
          status: "aborted",
          action: "abort_embedded_run",
          sessionId: "active-session",
          sessionKey,
          activeSessionId: "active-session",
          activeWorkKind: "embedded_run",
          aborted: true,
          drained: true,
          forceCleared: false,
          released: 0,
        };
      });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(freshOperation?.result).toBeNull();
    expect(replyResolver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting when recovery observes active reply work", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:active-reply-work";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery
      .mockResolvedValueOnce({
        status: "skipped",
        action: "keep_lane",
        reason: "active_reply_work",
        sessionId: "active-session",
        sessionKey,
        activeSessionId: "active-session",
        activeWorkKind: "embedded_run",
      })
      .mockImplementationOnce(async () => {
        activeOperation.fail("run_failed", new Error("stale reply operation"));
        return {
          status: "aborted",
          action: "abort_embedded_run",
          sessionId: "active-session",
          sessionKey,
          activeSessionId: "active-session",
          activeWorkKind: "embedded_run",
          aborted: true,
          drained: true,
          forceCleared: false,
          released: 0,
        };
      });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeOperation.result).toBeNull();
    expect(replyResolver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting when another recovery is already in flight", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:in-flight";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery
      .mockResolvedValueOnce({
        status: "skipped",
        action: "observe_only",
        reason: "already_in_flight",
        sessionId: "active-session",
        sessionKey,
      })
      .mockImplementationOnce(async () => {
        activeOperation.fail("run_failed", new Error("stale reply operation"));
        return {
          status: "aborted",
          action: "abort_embedded_run",
          sessionId: "active-session",
          sessionKey,
          activeSessionId: "active-session",
          activeWorkKind: "embedded_run",
          aborted: true,
          drained: true,
          forceCleared: false,
          released: 0,
        };
      });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(replyResolver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting when recovery observes an active lane task", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:active-lane-task";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery
      .mockResolvedValueOnce({
        status: "skipped",
        action: "keep_lane",
        reason: "active_lane_task",
        sessionId: "active-session",
        sessionKey,
        activeCount: 1,
        queuedCount: 1,
      })
      .mockImplementationOnce(async () => {
        activeOperation.fail("run_failed", new Error("stale reply operation"));
        return {
          status: "aborted",
          action: "abort_embedded_run",
          sessionId: "active-session",
          sessionKey,
          activeSessionId: "active-session",
          activeWorkKind: "embedded_run",
          aborted: true,
          drained: true,
          forceCleared: false,
          released: 0,
        };
      });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(replyResolver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not clear active reply work when recovery fails", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:recovery-failed";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockResolvedValue({
      status: "failed",
      action: "none",
      reason: "exception",
      sessionId: "active-session",
      sessionKey,
      error: "recovery failed",
    });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(activeOperation.result).toBeNull();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("clears stale reply work after recovery releases lane state", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:released-lane";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockResolvedValue({
      status: "released",
      action: "release_lane",
      sessionId: "active-session",
      sessionKey,
      released: 1,
    });

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).toHaveBeenCalledTimes(1);
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(activeOperation.result).toMatchObject({
      kind: "failed",
      code: "run_failed",
    });
  });

  it("does not run visible stuck recovery when diagnostics are disabled", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:telegram:direct:diagnostics-disabled";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);

    const resultPromise = dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "user:1",
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        BodyForAgent: "second telegram direct turn",
      }),
      cfg: {
        diagnostics: {
          enabled: false,
          stuckSessionWarnMs: 1_000,
          stuckSessionAbortMs: 1_000,
        },
      } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();

    activeOperation.complete();
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("releases inbound dedupe when active reply admission is aborted before processing", async () => {
    const sessionKey = "agent:main:telegram:direct:dedupe";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const abortController = new AbortController();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:user-1",
      To: "telegram:user-1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageSid: "message-1",
      BodyForAgent: "second visible turn",
    });
    const firstDispatcher = createDispatcher();
    const firstReplyResolver = vi.fn(
      async () => ({ text: "should not run" }) satisfies ReplyPayload,
    );

    const firstResult = dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: firstDispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver: firstReplyResolver,
    });
    setTimeout(() => abortController.abort(), 0);

    await expect(firstResult).resolves.toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(firstReplyResolver).not.toHaveBeenCalled();
    expect(firstDispatcher.sendFinalReply).not.toHaveBeenCalled();

    activeOperation.complete();

    const secondDispatcher = createDispatcher();
    const secondReplyResolver = vi.fn(
      async () => ({ text: "runs after dedupe release" }) satisfies ReplyPayload,
    );
    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: secondDispatcher,
        replyResolver: secondReplyResolver,
      }),
    ).resolves.toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
