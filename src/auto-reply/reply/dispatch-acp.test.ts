import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => managerMocks,
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: (sessionKey: string) => bindingServiceMocks.listBySession(sessionKey),
  }),
}));

const { tryDispatchAcpReply } = await import("./dispatch-acp.js");
const sessionKey = "agent:codex-acp:session-1";

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const dispatcher: ReplyDispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    markComplete: vi.fn(),
  };
  return { dispatcher, counts };
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: createAcpSessionMeta(),
  });
}

function createAcpConfigWithVisibleToolTags(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

function createLiveDeliveryConfig(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live" as const,
        coalesceIdleMs: 0,
        maxChunkChars: 64,
        tagVisibility: { tool_call: true },
      },
    },
  });
}

async function runDispatch(params: {
  bodyForAgent: string;
  cfg?: OpenClawConfig;
  dispatcher?: ReplyDispatcher;
  shouldRouteToOriginating?: boolean;
  onReplyStart?: () => void;
  ctxOverrides?: Record<string, unknown>;
}) {
  return tryDispatchAcpReply({
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: sessionKey,
      BodyForAgent: params.bodyForAgent,
      ...params.ctxOverrides,
    }),
    cfg: params.cfg ?? createAcpTestConfig(),
    dispatcher: params.dispatcher ?? createDispatcher().dispatcher,
    sessionKey,
    inboundAudio: false,
    shouldRouteToOriginating: params.shouldRouteToOriginating ?? false,
    ...(params.shouldRouteToOriginating
      ? { originatingChannel: "telegram", originatingTo: "telegram:thread-1" }
      : {}),
    shouldSendToolSummaries: true,
    bypassForCommand: false,
    ...(params.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    recordProcessed: vi.fn(),
    markIdle: vi.fn(),
  });
}

async function emitToolLifecycleEvents(
  onEvent: (event: unknown) => Promise<void>,
  toolCallId: string,
) {
  await onEvent({
    type: "tool_call",
    tag: "tool_call",
    toolCallId,
    status: "in_progress",
    title: "Run command",
    text: "Run command (in_progress)",
  });
  await onEvent({
    type: "tool_call",
    tag: "tool_call_update",
    toolCallId,
    status: "completed",
    title: "Run command",
    text: "Run command (completed)",
  });
  await onEvent({ type: "done" });
}

function mockToolLifecycleTurn(toolCallId: string) {
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await emitToolLifecycleEvents(onEvent, toolCallId);
    },
  );
}

function mockVisibleTextTurn(text = "visible") {
  managerMocks.runTurn.mockImplementationOnce(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

async function dispatchVisibleTurn(onReplyStart: () => void) {
  await runDispatch({
    bodyForAgent: "visible",
    dispatcher: createDispatcher().dispatcher,
    onReplyStart,
  });
}

describe("tryDispatchAcpReply", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.getObservabilitySnapshot.mockReset();
    managerMocks.getObservabilitySnapshot.mockReturnValue({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 0 },
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReset();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
    policyMocks.resolveAcpAgentPolicyError.mockReset();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
  });

  it("routes ACP block output to originating channel", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "hello", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(result?.counts.block).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
      }),
    );
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("edits ACP tool lifecycle updates in place when supported", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-1");
    routeMocks.routeReply.mockResolvedValueOnce({ ok: true, messageId: "tool-msg-1" });

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(messageActionMocks.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit",
        params: expect.objectContaining({
          messageId: "tool-msg-1",
        }),
      }),
    );
  });

  it("falls back to new tool message when edit fails", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-2");
    routeMocks.routeReply
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2" })
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2-fallback" });
    messageActionMocks.runMessageAction.mockRejectedValueOnce(new Error("edit unsupported"));

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(messageActionMocks.runMessageAction).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle when ACP turn starts, including hidden-only turns", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "status",
          tag: "usage_update",
          text: "usage updated: 1/100",
          used: 1,
          size: 100,
        });
        await onEvent({ type: "done" });
      },
    );
    await runDispatch({
      bodyForAgent: "hidden",
      dispatcher,
      onReplyStart,
    });
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);
    expect(onReplyStart).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle once per turn when output is delivered", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty ACP prompt", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "   ",
      dispatcher,
      onReplyStart,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("forwards normalized image attachments into ACP turns", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "inbound.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: imagePath,
          MediaType: "image/png",
        },
      });

      expect(managerMocks.runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          attachments: [
            {
              mediaType: "image/png",
              data: Buffer.from("image-bytes").toString("base64"),
            },
          ],
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips ACP turns for non-image attachments when there is no text prompt", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const docPath = path.join(tempDir, "inbound.pdf");
    const { dispatcher } = createDispatcher();
    const onReplyStart = vi.fn();
    try {
      await fs.writeFile(docPath, "pdf-bytes");

      await runDispatch({
        bodyForAgent: "   ",
        dispatcher,
        onReplyStart,
        ctxOverrides: {
          MediaPath: docPath,
          MediaType: "application/pdf",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
      expect(onReplyStart).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes an abort signal to runTurn for timeout protection", async () => {
    setReadyAcpResolution();
    let receivedSignal: AbortSignal | undefined;
    managerMocks.runTurn.mockImplementationOnce(
      async ({
        onEvent,
        signal,
      }: {
        onEvent: (event: unknown) => Promise<void>;
        signal?: AbortSignal;
      }) => {
        receivedSignal = signal;
        await onEvent({ type: "done" });
      },
    );

    await runDispatch({ bodyForAgent: "hello" });

    expect(managerMocks.runTurn).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBeDefined();
    expect(typeof receivedSignal!.aborted).toBe("boolean");
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("aborts runTurn when the turn timeout fires", async () => {
    vi.useFakeTimers();
    try {
      setReadyAcpResolution();
      let receivedSignal: AbortSignal | undefined;
      managerMocks.runTurn.mockImplementationOnce(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            receivedSignal = signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );

      const dispatchPromise = runDispatch({ bodyForAgent: "stall" });
      await vi.runAllTimersAsync();
      await expect(dispatchPromise).resolves.toBeDefined();
      expect(receivedSignal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards in-flight onEvent delivery after turn abort fires (turnAbortFired gate)", async () => {
    // Regression: when the withTimeout abort fires, Promise.race resolves
    // immediately but the abandoned work(signal) promise may still have a
    // projector.onEvent callback mid-await. Without the turnAbortFired gate,
    // that in-flight callback can call delivery.deliver() after the timeout
    // error reply has already been sent, emitting contradictory responses.
    // refs review comment 2921609064 on PR #36860.
    vi.useFakeTimers();
    try {
      setReadyAcpResolution();
      let capturedOnEvent: ((event: unknown) => Promise<void>) | undefined;
      const { dispatcher } = createDispatcher();

      managerMocks.runTurn.mockImplementationOnce(
        ({ onEvent }: { onEvent: (event: unknown) => Promise<void>; signal?: AbortSignal }) => {
          capturedOnEvent = onEvent;
          // Hang indefinitely — simulates a stalled SSE connection.
          // Promise.race in withTimeout handles the abort; we don't
          // need to explicitly reject here.
          return new Promise<void>(() => {});
        },
      );

      const dispatchPromise = runDispatch({ bodyForAgent: "stall", dispatcher });
      // Fire the withTimeout turn timer (MIN_ACP_TURN_TIMEOUT_MS = 30_000ms).
      await vi.runAllTimersAsync();
      // Dispatch completes via the error path once the timeout fires.
      await dispatchPromise;

      // turnAbortFired is now true. Simulate a stale in-flight onEvent call
      // that was mid-await when the abort fired (e.g., awaiting an upstream
      // delivery while the timeout expired).
      expect(capturedOnEvent).toBeDefined();
      await capturedOnEvent!({
        type: "text_delta",
        text: "stale-post-abort",
        tag: "agent_message_chunk",
      });

      // No block content should have been delivered — the entry guard and
      // the deliver() wrapper both discard stale events after abort fires.
      expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      // The timeout error reply IS delivered via the direct delivery.deliver()
      // call in the catch block, which bypasses the turnAbortFired gate.
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({ isError: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards in-flight onEvent delivery when cancelSession combined abort fires (onCombinedAbort gate)", async () => {
    // Regression: turnAbortFired was only set from the withTimeout signal, but
    // cancelSession aborts the manager's internal controller (which fires the
    // combined signal), not the withTimeout signal. An in-flight
    // projector.onEvent could therefore call deliver() after runTurn exited via
    // the cancel path — emitting stale content before the error reply.
    // Fix: onCombinedAbort sets turnAbortFired for ALL abort sources, not just
    // timeout. refs review comment 2924797850 on PR #36860.
    setReadyAcpResolution();

    let capturedOnEvent: ((event: unknown) => Promise<void>) | undefined;
    const { dispatcher } = createDispatcher();

    managerMocks.runTurn.mockImplementationOnce(
      ({
        onEvent,
        onCombinedAbort,
      }: {
        onEvent: (event: unknown) => Promise<void>;
        onCombinedAbort?: () => void;
      }) => {
        capturedOnEvent = onEvent;
        // Simulate cancelSession: the combined signal fires (sets turnAbortFired
        // via onCombinedAbort), then runTurn rejects — matching the real path
        // where internalAbortController.abort() fires the combined signal before
        // the runtime error propagates back.
        onCombinedAbort?.();
        return Promise.reject(new AcpRuntimeError("ACP_TURN_FAILED", "Session was cancelled."));
      },
    );

    await runDispatch({ bodyForAgent: "cancel-test", dispatcher });

    // Simulate a stale in-flight onEvent callback that was mid-await when the
    // combined abort fired. turnAbortFired must already be true (set by
    // onCombinedAbort) so deliver() is blocked.
    expect(capturedOnEvent).toBeDefined();
    await capturedOnEvent!({
      type: "text_delta",
      text: "stale-post-cancel",
      tag: "agent_message_chunk",
    });

    // No block content should have been delivered — turnAbortFired was set
    // by onCombinedAbort before the in-flight onEvent could call deliver().
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    // The cancel error reply IS delivered via the direct delivery.deliver()
    // call in the catch block, which bypasses the turnAbortFired gate.
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
    );
  });

  it("awaits in-flight projector delivery before sending timeout error reply", async () => {
    // Regression: when the abort fires while delivery.deliver() is mid-await
    // (e.g. an in-flight routeReply during a live tool event), the catch path
    // used to send the timeout error reply concurrently with the still-running
    // delivery. With lastDeliveryPromise tracking, the catch path awaits
    // settlement first (bounded by 5 s), serialising the sends.
    // refs review comments 2921919543 and 2922136054 on PR #36860.
    vi.useFakeTimers();
    try {
      setReadyAcpResolution();

      let resolveDeliver!: () => void;
      const deliverBarrier = new Promise<void>((res) => {
        resolveDeliver = res;
      });

      const routeReplyOrder: string[] = [];
      routeMocks.routeReply
        .mockImplementationOnce(async () => {
          // In-flight tool delivery: hang on barrier so the turn timeout fires
          // while this send is still in progress.
          routeReplyOrder.push("tool-start");
          await deliverBarrier;
          routeReplyOrder.push("tool-done");
          return { ok: true, messageId: "live-tool" };
        })
        .mockImplementationOnce(async () => {
          // Timeout error reply — must arrive after the tool delivery settles.
          routeReplyOrder.push("error");
          return { ok: true, messageId: "error-reply" };
        });

      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          // Emit a tool_call event. In live mode with tool_call visible this
          // triggers an immediate params.deliver("tool", ...) call inside the
          // projector, which reaches delivery.deliver() → routeReply and hangs
          // on deliverBarrier. runTurn (and therefore withTimeout's work
          // promise) remains suspended until deliverBarrier is resolved.
          await onEvent({
            type: "tool_call",
            tag: "tool_call",
            toolCallId: "tc-live-1",
            status: "in_progress",
            title: "Live tool",
            text: "Live tool (in_progress)",
          });
        },
      );

      const dispatchPromise = runDispatch({
        bodyForAgent: "run live tool",
        cfg: createLiveDeliveryConfig(),
        shouldRouteToOriginating: true,
      });

      // Advance only enough to fire the turn timeout (default 600 s via
      // resolveAgentTimeoutMs with no config override). Using advanceTimersByTimeAsync
      // rather than runAllTimersAsync is intentional: runAllTimersAsync would also
      // fire the 5 s bounded-wait timer that the catch block registers
      // (Promise.race([lastDeliveryPromise, setTimeout(5_000)])), causing the
      // error reply to be sent before the in-flight delivery settles.
      // By advancing exactly to the turn timeout we leave the 5 s safety timer
      // unfired so that Promise.race can still resolve via lastDeliveryPromise.
      const TURN_TIMEOUT_MS = 600_000;
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);

      // dispatchPromise is still pending: the catch block is suspended inside
      // Promise.race([lastDeliveryPromise, setTimeout(5_000)]) waiting for
      // either the delivery or the 5 s safety timeout. Resolve the barrier now
      // (within the 5 s window) so the race settles via lastDeliveryPromise.
      resolveDeliver();

      await dispatchPromise;

      // The error reply (routed via routeReply when shouldRouteToOriginating)
      // must appear only after the in-flight tool delivery has settled.
      expect(routeReplyOrder).toEqual(["tool-start", "tool-done", "error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends timeout error reply even when in-flight delivery stalls beyond bounded wait", async () => {
    // Regression guard for PR #36860 comment 2922136054: if the in-flight
    // delivery promise never settles, the 5 s safety timer in
    // Promise.race([lastDeliveryPromise, setTimeout(5_000)]) must unblock the
    // catch path so the timeout error reply is still sent.
    vi.useFakeTimers();
    try {
      setReadyAcpResolution();

      // deliverBarrier is never resolved — simulates a stalled routed send.
      const deliverBarrier = new Promise<void>(() => {});

      const routeReplyOrder: string[] = [];
      routeMocks.routeReply
        .mockImplementationOnce(async () => {
          routeReplyOrder.push("tool-start");
          await deliverBarrier; // hangs forever
          routeReplyOrder.push("tool-done");
          return { ok: true, messageId: "live-tool" };
        })
        .mockImplementationOnce(async () => {
          routeReplyOrder.push("error");
          return { ok: true, messageId: "error-reply" };
        });

      managerMocks.runTurn.mockImplementationOnce(
        async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
          await onEvent({
            type: "tool_call",
            tag: "tool_call",
            toolCallId: "tc-stall-1",
            status: "in_progress",
            title: "Stalling tool",
            text: "Stalling tool (in_progress)",
          });
        },
      );

      const dispatchPromise = runDispatch({
        bodyForAgent: "run stalling tool",
        cfg: createLiveDeliveryConfig(),
        shouldRouteToOriginating: true,
      });

      // Fire the turn timeout AND the 5 s safety timer in one shot.
      // The stalled delivery never resolves, so Promise.race resolves via
      // the safety timeout and the error reply is sent regardless.
      await vi.runAllTimersAsync();

      await dispatchPromise;

      // "tool-done" never pushes because deliverBarrier is unresolved, but
      // the error reply MUST still be delivered (safety timer unblocked the catch).
      expect(routeReplyOrder).toEqual(["tool-start", "error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces ACP policy errors as final error replies", async () => {
    setReadyAcpResolution();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy."),
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACP_DISPATCH_DISABLED"),
      }),
    );
  });
});
