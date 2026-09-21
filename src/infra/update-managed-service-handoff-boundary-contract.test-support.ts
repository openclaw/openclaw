import type { ManagedServiceManagerBoundaryOptions } from "./update-managed-service-handoff-lifecycle.test-support.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type ManagedServiceBoundaryOptions = ManagedServiceManagerBoundaryOptions & {
  trigger?: "cli" | "api" | "campaign";
  origin?: UpdateRunRecord["origin"];
  controlDisconnect?: "transferred" | "unarmed" | "dead-parent";
  beforeDisconnect?: (
    run: UpdateRunRecord | undefined,
    env: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
  relativeInput?: boolean;
  validationResult?: "failed" | "skipped";
  validationClockAdvanceMs?: number;
  cancelDuringValidation?: boolean;
  cancelAtActivation?: "requester" | "inspection";
  runnerFallback?: boolean;
  selectedDriver?: "2026.9.3";
  revokeWhileValidating?: boolean;
  replaceLedgerWriter?: boolean;
  finalizationWorkMs?: number;
  beforeParkNotice?: "acknowledged" | "stalled" | "rejected";
};
