/** Content-free facts, never proof of model progress or authority to stop a turn. */
export type CliBackendTurnAssessment =
  | { state: "closed"; basis: "process_exited" | "transport_closed" }
  | {
      state: "unknown";
      basis: "process_present" | "status_unsupported" | "busy" | "transient_error";
    };

/** Capture the exact native input/generation without submitting work or changing hooks. */
export type CliBackendTurnStatus = {
  capture():
    | {
        isCurrent(): boolean;
        assess(params: { signal: AbortSignal }): Promise<CliBackendTurnAssessment>;
      }
    | undefined;
};
