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
import type { CronParentUnavailable } from "./types.js";

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
  /** Set when the exact parent is removed or archived, or its bound worktree is gone. */
  pause?: CronParentUnavailable;
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

/** The single notice a paused job sends; names the parent and the repair. */
export function buildScheduledParentPauseNotice(params: {
  job: { id: string; name?: string };
  pause: CronParentUnavailable;
}): string {
  const name = (params.job.name || params.job.id).replace(/\s+/g, " ").trim().slice(0, 120);
  const { pause } = params;
  const cause =
    pause.reason === "worktree-missing"
      ? `its worktree \`${pause.worktreePath ?? "unknown"}\` no longer exists`
      : `it was ${pause.reason}`;
  return [
    `⚠️ Automation "${name}" is paused because the conversation that created it, \`${pause.parentSessionKey}\`, is unavailable: ${cause}.`,
    "Its runs used that conversation's access, and no other access is used in its place.",
    `Restore the conversation and run \`openclaw automations enable ${params.job.id}\`, or recreate the automation from another conversation.`,
  ].join("\n");
}
