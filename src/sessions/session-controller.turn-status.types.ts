import type { CliBackendTurnAssessment } from "../plugins/cli-backend-turn-status.types.js";

// Leaf contract: the watchdog imports this without the backend handle module graph.
export type ReplyBackendTurnAssessment =
  | CliBackendTurnAssessment
  | { state: "unknown"; basis: "timeout" | "failed" | "invalid" };

export type ReplyBackendTurnStatus = {
  capture():
    | {
        isCurrent(): boolean;
        assess(params: { signal: AbortSignal }): Promise<ReplyBackendTurnAssessment>;
      }
    | undefined;
};
