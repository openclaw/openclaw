import { describe, expect, it, vi } from "vitest";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { createChatSendDispatchErrorLifecycle } from "./chat-send-dispatch-errors.js";

describe("createChatSendDispatchErrorLifecycle", () => {
  it("terminalizes an admitted queued followup as successful despite later dispatch failure", async () => {
    const broadcast = vi.fn();
    const cleanupAdmittedRun = vi.fn();
    const removeChatRun = vi.fn();
    const warn = vi.fn();
    const dedupe = new Map();
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        activeRunAbort: {
          cleanup: vi.fn(),
          controller: new AbortController(),
          entry: undefined,
          registered: true,
        } as never,
        cleanupAdmittedRun,
        lifecycleGeneration: 1,
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatAbortedRuns: new Set(),
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn },
        nodeSendToSession: vi.fn(),
        removeChatRun,
      } as never,
      isQueuedFollowupEnqueued: () => true,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: undefined,
        cfg: {},
        clientRunId: "run-1",
        now: 1,
        rawSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
      userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
    });

    await lifecycle.handleError(new Error("late failure"));
    lifecycle.finalize();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dispatch failed after followup queue admission"),
    );
    expect(dedupe.get("chat:run-1")).toMatchObject({
      ok: true,
      payload: { runId: "run-1", status: "ok" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "final" }),
    );
    expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
    expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "agent:main:main");
  });
  it("retains an explicit abort terminal owner across a later dispatch rejection", async () => {
    const runId = "explicit-abort-pending-owner";
    const sessionKey = "agent:main:main";
    const chatAbortControllers = new Map();
    const chatAbortedRuns = new Map();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: "sess-main",
      sessionKey,
      timeoutMs: 60_000,
    });
    expect(registration.entry).toBeDefined();
    const entry = registration.entry;
    const runtimeUnsub = onAgentRuntimeEvent((event) => {
      if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
        return;
      }
      const current = chatAbortControllers.get(runId);
      if (current) {
        current.projectSessionTerminalPending = true;
        current.projectSessionTerminalObservedAt = event.ts;
      }
    });
    try {
      expect(
        abortChatRunById(
          {
            chatAbortControllers,
            chatRunBuffers: new Map(),
            chatAbortedRuns,
            clearChatRunState: vi.fn(),
            removeChatRun: vi.fn(),
            agentRunSeq: new Map(),
            broadcast: vi.fn(),
            nodeSendToSession: vi.fn(),
          },
          { runId, sessionKey },
        ),
      ).toEqual({ aborted: true });
      expect(chatAbortControllers.get(runId)).toBe(entry);
      expect(entry?.projectSessionTerminalPending).toBe(true);

      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: registration.cleanup,
          lifecycleGeneration: "test-generation",
          restartSafeAdmission: undefined,
        },
        context: {
          agentRunSeq: new Map(),
          broadcast: vi.fn(),
          chatAbortedRuns,
          dedupe: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
          nodeSendToSession: vi.fn(),
          removeChatRun: vi.fn(),
        } as never,
        isQueuedFollowupEnqueued: () => false,
        persistUserTurnTranscript: async () => undefined,
        session: {
          agentId: "main",
          backingSessionId: "sess-main",
          cfg: {},
          clientRunId: runId,
          now: 1,
          rawSessionKey: sessionKey,
          sessionKey,
        },
        terminalizeRestartSafeAdmission: vi.fn(),
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
      lifecycle.finalize();

      expect(chatAbortControllers.get(runId)).toBe(entry);
      expect(entry).toMatchObject({
        projectSessionTerminalPending: true,
        registrationCleanupRequested: true,
      });
    } finally {
      runtimeUnsub();
    }
  });

  it("keeps root work admitted while explicit-abort fallback transcript persistence is pending", async () => {
    resetGatewayWorkAdmission();
    const rootAdmission = tryBeginGatewayRootWorkAdmission();
    if (!rootAdmission) {
      throw new Error("expected root admission");
    }
    const runId = "explicit-abort-transcript-root";
    const sessionKey = "agent:main:main";
    const chatAbortControllers = new Map();
    const chatAbortedRuns = new Map();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: "sess-main",
      sessionKey,
      timeoutMs: 60_000,
    });
    let resolveTranscript: () => void = () => undefined;
    const transcriptPending = new Promise<void>((resolve) => {
      resolveTranscript = resolve;
    });
    let transcriptStarted = false;
    const runtimeUnsub = onAgentRuntimeEvent((event) => {
      if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
        return;
      }
      const current = chatAbortControllers.get(runId);
      if (current) {
        current.projectSessionTerminalPending = true;
        current.projectSessionTerminalObservedAt = event.ts;
      }
    });
    let handling: Promise<void> | undefined;
    try {
      expect(
        abortChatRunById(
          {
            chatAbortControllers,
            chatRunBuffers: new Map(),
            chatAbortedRuns,
            clearChatRunState: vi.fn(),
            removeChatRun: vi.fn(),
            agentRunSeq: new Map(),
            broadcast: vi.fn(),
            nodeSendToSession: vi.fn(),
          },
          { runId, sessionKey },
        ),
      ).toEqual({ aborted: true });
      expect(chatAbortControllers.get(runId)?.projectSessionTerminalPending).toBe(true);

      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: () => {
            registration.cleanup();
            rootAdmission.release();
          },
          lifecycleGeneration: "test-generation",
          restartSafeAdmission: undefined,
        },
        context: {
          agentRunSeq: new Map(),
          broadcast: vi.fn(),
          chatAbortedRuns,
          dedupe: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
          nodeSendToSession: vi.fn(),
          removeChatRun: vi.fn(),
        } as never,
        isQueuedFollowupEnqueued: () => false,
        persistUserTurnTranscript: async () => {
          transcriptStarted = true;
          await transcriptPending;
        },
        session: {
          agentId: "main",
          backingSessionId: "sess-main",
          cfg: {},
          clientRunId: runId,
          now: 1,
          rawSessionKey: sessionKey,
          sessionKey,
        },
        terminalizeRestartSafeAdmission: vi.fn(),
        userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
      });

      handling = rootAdmission.run(() =>
        lifecycle.handleError(new Error("dispatch rejected after abort")),
      );
      await vi.waitFor(() => expect(transcriptStarted).toBe(true));
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      resolveTranscript();
      await handling;
      handling = undefined;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      resolveTranscript();
      await handling?.catch(() => undefined);
      runtimeUnsub();
      rootAdmission.release();
      resetGatewayWorkAdmission();
    }
  });
});
