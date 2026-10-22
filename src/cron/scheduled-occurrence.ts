/**
 * The admitted-occurrence contract shared by the cron service and every
 * executor. `admitScheduledOccurrence` in `execution-context-admission.ts`
 * creates occurrences; this module stays free of runtime dependencies so cron
 * core can import it.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ScheduledExecutionContextResult,
  ScheduledExecutionFacts,
} from "./execution-context.js";

export type ScheduledExecutionContext = ScheduledExecutionFacts &
  Readonly<{
    /** Throws when the parent incarnation or the admitted run is no longer current. */
    assertCurrent: () => void;
  }>;

/** Run-specific facts an executor supplies when its run is admitted. */
export type ScheduledOccurrenceRun = {
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  runSessionKey: string;
  toolsAllow?: readonly string[];
  /** Restored operator source authority, when the occurrence carries one. */
  operatorAuthorityRestored: boolean;
};

export type MintedScheduledExecution = Readonly<{
  result: ScheduledExecutionContextResult;
  /** Binds the context to the admitted run; the admission owner reads it through `current`. */
  bind: (assertAdmitted: () => void) => void;
  current: () => ScheduledExecutionContext | undefined;
  release: () => void;
}>;

/** One admitted occurrence. Every scheduled agent run mints its context from it. */
export type ScheduledOccurrence = Readonly<{
  mint: (run: ScheduledOccurrenceRun) => MintedScheduledExecution;
  /** Releases the parent generation; the occurrence owner calls it once the occurrence settles. */
  release: () => void;
}>;

/** A run whose context could not be built. */
export function failedScheduledExecution(error: string): MintedScheduledExecution {
  return {
    result: { status: "fail", error },
    bind() {},
    current: () => undefined,
    release() {},
  };
}

/** An occurrence whose admission could not run; every run it mints is a `fail` result. */
export function unadmittedScheduledOccurrence(error: string): ScheduledOccurrence {
  return { mint: () => failedScheduledExecution(error), release() {} };
}
