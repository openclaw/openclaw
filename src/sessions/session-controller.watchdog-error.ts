import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import type { DiagnosticToolAwaiting } from "../infra/diagnostic-tool-execution-liveness.js";
import type { ReplyBackendTurnAssessment } from "./session-controller.turn-status.types.js";

export class SessionWatchdogError extends Error {
  override name = "AbortError";
  readonly code = "OPENCLAW_SESSION_WATCHDOG";
  declare readonly assessment?: ReplyBackendTurnAssessment & { durationMs: number };

  constructor(
    message: string,
    readonly staleReason: "no_activity" | "rate_limited",
    readonly pendingTools: {
      toolName: string;
      toolCallId: string;
      elapsedMs: number;
      awaiting?: readonly DiagnosticToolAwaiting[];
    }[],
    assessment?: ReplyBackendTurnAssessment & { durationMs: number },
  ) {
    super(message);
    if (assessment) {
      this.assessment = assessment;
    }
  }
}

/** Project only controller-owned identities, including through lane error wrappers. */
export function readSessionWatchdogFailure(error: unknown) {
  for (const candidate of collectNestedErrorCandidates(error)) {
    if (candidate instanceof SessionWatchdogError) {
      return { staleReason: candidate.staleReason, pendingTools: candidate.pendingTools };
    }
  }
  return undefined;
}
