import { vi } from "vitest";

/** Install a mock addEventListener that captures the chat event listener.
 * Returns the listener setter so tests can emit events.
 */
type ChatListener = (event: { event: string; payload?: unknown }) => void;
export function createMockAddEventListener() {
  let listener: ChatListener | undefined;
  const addEventListener = vi.fn((callback: ChatListener) => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  });
  return {
    addEventListener,
    emitChat: (payload: unknown) => listener?.({ event: "chat", payload }),
    listener: () => listener,
  };
}

/** Default empty-final fallback message. */
export const EMPTY_FINAL_FALLBACK = "OpenClaw finished with no text.";

/**
 * Create a pending agent.wait response that includes a follow-up runId.
 * This matches the production shape after the security fix.
 */
export function pendingWithFollowup(runId: string, followupRunId: string) {
  return { runId, status: "pending" as const, followupRunId };
}

/**
 * Create a pending agent.wait response without a follow-up runId.
 * Used to test the delayed-allocation observation path.
 */
export function pendingWithoutFollowup(runId: string) {
  return { runId, status: "pending" as const };
}

/**
 * Create a terminal agent.wait response (ok).
 */
export function terminalOk(runId: string) {
  return { runId, status: "ok" as const };
}

/**
 * Create an empty-final chat event payload for the given runId.
 */
export function emptyFinalPayload(runId: string) {
  return { runId, state: "final", message: { text: "" } };
}

/**
 * Create a text-bearing chat event payload for the given runId.
 */
export function textFinalPayload(runId: string, text: string) {
  return {
    runId,
    state: "final",
    message: {
      role: "assistant" as const,
      provider: "openclaw" as const,
      model: "delivery-mirror" as const,
      text,
    },
  };
}
