import {
  clearActiveEmbeddedRun,
  moveActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "../../agents/pi-embedded-runner/runs.js";

export type ReplyOperationPhase =
  | "queued"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_failed";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: "aborted_by_user" };

export type ReplyOperation = {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  readonly registryHandle: EmbeddedPiQueueHandle;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  moveSession(nextSessionId: string, nextSessionKey?: string): void;
  attachEmbeddedHandle(handle: EmbeddedPiQueueHandle): void;
  detachEmbeddedHandle(handle: EmbeddedPiQueueHandle): void;
  complete(): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
};

function createUserAbortError(): Error {
  const err = new Error("Reply operation aborted by user");
  err.name = "AbortError";
  return err;
}

export function createReplyOperation(params: {
  sessionId: string;
  sessionKey?: string;
  resetTriggered: boolean;
  upstreamAbortSignal?: AbortSignal;
}): ReplyOperation {
  const controller = new AbortController();
  let currentSessionId = params.sessionId;
  let currentSessionKey = params.sessionKey;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  let attachedEmbeddedHandle: EmbeddedPiQueueHandle | undefined;
  let registryCleared = false;

  const clearRegistryHandle = () => {
    if (registryCleared) {
      return;
    }
    registryCleared = true;
    clearActiveEmbeddedRun(currentSessionId, registryHandle, currentSessionKey);
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const registryHandle: EmbeddedPiQueueHandle = {
    queueMessage: async (text: string) => {
      if (phase !== "running" || !attachedEmbeddedHandle) {
        return;
      }
      await attachedEmbeddedHandle.queueMessage(text);
    },
    isStreaming: () => {
      return phase === "running" && attachedEmbeddedHandle
        ? attachedEmbeddedHandle.isStreaming()
        : false;
    },
    isCompacting: () => {
      if (phase === "preflight_compacting" || phase === "memory_flushing") {
        return true;
      }
      if (phase !== "running" || !attachedEmbeddedHandle) {
        return false;
      }
      return attachedEmbeddedHandle.isCompacting();
    },
    abort: () => {
      operation.abortByUser();
      attachedEmbeddedHandle?.abort();
    },
  };

  if (params.upstreamAbortSignal) {
    if (params.upstreamAbortSignal.aborted) {
      abortInternally(params.upstreamAbortSignal.reason);
    } else {
      params.upstreamAbortSignal.addEventListener(
        "abort",
        () => {
          abortInternally(params.upstreamAbortSignal?.reason);
        },
        { once: true },
      );
    }
  }
  setActiveEmbeddedRun(currentSessionId, registryHandle, currentSessionKey);

  const operation: ReplyOperation = {
    get sessionId() {
      return currentSessionId;
    },
    get sessionKey() {
      return currentSessionKey;
    },
    get abortSignal() {
      return controller.signal;
    },
    get resetTriggered() {
      return params.resetTriggered;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
    get registryHandle() {
      return registryHandle;
    },
    setPhase(next) {
      if (result) {
        return;
      }
      phase = next;
    },
    moveSession(nextSessionId, nextSessionKey) {
      if (result) {
        return;
      }
      const cleanedSessionId = nextSessionId.trim();
      if (!cleanedSessionId) {
        return;
      }
      const cleanedSessionKey = nextSessionKey?.trim() || undefined;
      if (cleanedSessionId === currentSessionId && cleanedSessionKey === currentSessionKey) {
        return;
      }
      const moved = moveActiveEmbeddedRun({
        fromSessionId: currentSessionId,
        toSessionId: cleanedSessionId,
        handle: registryHandle,
        fromSessionKey: currentSessionKey,
        toSessionKey: cleanedSessionKey,
      });
      if (!moved) {
        return;
      }
      currentSessionId = cleanedSessionId;
      currentSessionKey = cleanedSessionKey;
    },
    attachEmbeddedHandle(handle) {
      if (result) {
        return;
      }
      attachedEmbeddedHandle = handle;
    },
    detachEmbeddedHandle(handle) {
      if (attachedEmbeddedHandle === handle) {
        attachedEmbeddedHandle = undefined;
      }
    },
    complete() {
      if (!result) {
        result = { kind: "completed" };
        phase = "completed";
      }
      clearRegistryHandle();
    },
    fail(code, cause) {
      if (!result) {
        result = { kind: "failed", code, cause };
        phase = "failed";
      }
      clearRegistryHandle();
    },
    abortByUser() {
      const phaseBeforeAbort = phase;
      if (!result) {
        result = { kind: "aborted", code: "aborted_by_user" };
      }
      phase = "aborted";
      abortInternally(createUserAbortError());
      if (phaseBeforeAbort === "queued") {
        clearRegistryHandle();
      }
    },
  };

  return operation;
}
