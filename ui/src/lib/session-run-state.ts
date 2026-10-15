import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractAssistantPhaseText,
  resolveAssistantMessagePhase,
} from "../../../src/shared/chat-message-content.js";
import { isSessionRunActive } from "../../../src/shared/session-run-state.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";

export { isSessionRunActive };

/** Presentation only: settlement still owns an active, abortable run. */
export function isSessionRunVisuallyActive(active: boolean, phase?: string): boolean {
  return active && phase !== "finishing" && phase !== "answer";
}

/** Connection-scoped presentation facts; registry ownership is never changed here. */
export class SessionRunVisualActivity {
  private readonly phases = new Map<
    string,
    Map<string, { phase?: "answer" | "finishing"; seq?: number }>
  >();

  observe(event: GatewayEventFrame): boolean {
    const payload = asOptionalRecord(event.payload);
    const data = asOptionalRecord(payload?.data);
    if (typeof payload?.sessionKey !== "string" || typeof payload.runId !== "string") {
      return false;
    }
    const runs = this.phases.get(payload.sessionKey);
    const previous = runs?.get(payload.runId);
    // Agent sequences are monotonic across attempts; chat deltas use a separate counter.
    const seq =
      event.event === "agent" && typeof payload.seq === "number" ? payload.seq : undefined;
    if (previous?.seq !== undefined && seq !== undefined && seq <= previous.seq) {
      return false;
    }
    if (previous?.phase === "finishing" && seq === undefined) {
      return false;
    }
    const hasAnswer =
      event.event === "chat"
        ? payload.state === "delta" &&
          resolveAssistantMessagePhase(payload.message) !== "commentary" &&
          Boolean(extractAssistantPhaseText(payload.message))
        : payload.stream === "assistant" &&
          Boolean(data?.text || data?.delta) &&
          data?.phase !== "commentary";
    const phase =
      payload.stream === "lifecycle" && data?.phase === "finishing"
        ? "finishing"
        : hasAnswer
          ? "answer"
          : undefined;
    const foreground =
      ((payload.stream === "tool" || (payload.stream === "item" && data?.kind === "tool")) &&
        data?.phase === "start") ||
      (payload.stream === "assistant" &&
        data?.phase === "commentary" &&
        (data.text || data.delta)) ||
      (payload.stream === "thinking" && data?.phase !== "persisted") ||
      (payload.stream === "run_status" && data?.phase === "retrying") ||
      (payload.stream === "lifecycle" &&
        (data?.phase === "start" ||
          (data?.phase === "fallback_step" && data.fallbackStepFinalOutcome === "next_fallback")));
    if (phase || foreground) {
      const next = runs ?? new Map<string, { phase?: "answer" | "finishing"; seq?: number }>();
      next.set(payload.runId, { phase, seq: seq ?? previous?.seq });
      this.phases.set(payload.sessionKey, next);
      return previous?.phase !== phase;
    }
    return false;
  }

  isActive = (row: GatewaySessionRow): boolean => {
    const phases = this.phases.get(row.key);
    const settled =
      phases &&
      (row.activeRunIds?.length
        ? row.activeRunIds.every((runId) => phases.get(runId)?.phase)
        : [...phases.values()].some((entry) => entry.phase));
    return isSessionRunVisuallyActive(isSessionRunActive(row), settled ? "answer" : undefined);
  };

  retire(sessionKey: string): void {
    this.phases.delete(sessionKey);
  }

  clear(): void {
    this.phases.clear();
  }
}
