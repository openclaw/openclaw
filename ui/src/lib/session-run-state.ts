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
  private readonly phases = new Map<string, Map<string, "answer" | "finishing">>();

  observe(event: GatewayEventFrame): boolean {
    const payload = asOptionalRecord(event.payload);
    const data = asOptionalRecord(payload?.data);
    if (typeof payload?.sessionKey !== "string" || typeof payload.runId !== "string") {
      return false;
    }
    const runs = this.phases.get(payload.sessionKey);
    const previous = runs?.get(payload.runId);
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
    if (previous !== "finishing" && phase && previous !== phase) {
      const next = runs ?? new Map<string, "answer" | "finishing">();
      next.set(payload.runId, phase);
      this.phases.set(payload.sessionKey, next);
      return true;
    }
    if (
      previous === "answer" &&
      ((payload.stream === "tool" && data?.phase === "start") ||
        (payload.stream === "assistant" && data?.phase === "commentary" && data.text))
    ) {
      runs?.delete(payload.runId);
      return true;
    }
    return false;
  }

  isActive = (row: GatewaySessionRow): boolean => {
    const phases = this.phases.get(row.key);
    const settled =
      phases &&
      (row.activeRunIds?.length
        ? row.activeRunIds.every((runId) => phases.has(runId))
        : phases.size > 0);
    return isSessionRunVisuallyActive(isSessionRunActive(row), settled ? "answer" : undefined);
  };

  retire(sessionKey: string): void {
    this.phases.delete(sessionKey);
  }

  clear(): void {
    this.phases.clear();
  }
}
