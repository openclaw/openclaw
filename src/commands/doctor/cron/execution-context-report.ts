// Classifies stored automations by how the scheduled-run execution context
// changes what they may access, and formats Doctor's read-only report. Pure.
import { formatCliCommand } from "../../../cli/command-format.js";
import {
  compareScheduledDecisions,
  type ScheduledDivergence,
} from "../../../cron/execution-context-projection.js";
import {
  resolveScheduledPrincipal,
  type ScheduledAdmissionFacts,
  type ScheduledExecutionContextResult,
} from "../../../cron/execution-context.js";
import type { CronStoredJob } from "../../../cron/types.js";
import { countLabel as pluralize } from "../../doctor-state-integrity-format.js";

type JobRef = Readonly<{ id: string; name: string; enabled: boolean }>;

type LostField = ScheduledDivergence["changes"][number];

/** How the requester's current owner status was established for this report. */
export type ScheduledOwnerCheck = "checked" | "unverified" | "not-needed";

export type ScheduledContextReport = {
  losses: Array<{ job: JobRef; fields: LostField[]; ownerCheck: ScheduledOwnerCheck }>;
  pauses: Array<{
    job: JobRef;
    parentSessionKey: string;
    cause: "removed" | "archived" | "worktree-missing";
    worktreePath?: string;
  }>;
  unbound: Array<{ job: JobRef; parentSessionKey: string; cause: "key-only" | "reset" }>;
  runtimeOwner: Array<{ job: JobRef; cliBackend: string }>;
  missingChatType: Array<{ job: JobRef; parentSessionKey: string }>;
  failed: Array<{ job: JobRef; reason: string }>;
};

export function emptyScheduledContextReport(): ScheduledContextReport {
  return {
    losses: [],
    pauses: [],
    unbound: [],
    runtimeOwner: [],
    missingChatType: [],
    failed: [],
  };
}

/** What the collector read for one job; every field is a stored or config fact. */
export type ScheduledJobObservation = {
  job: CronStoredJob;
  facts: ScheduledAdmissionFacts;
  result: ScheduledExecutionContextResult;
  ownerCheck: ScheduledOwnerCheck;
  /** The parent row's chat-type facts, when the job names a parent that exists. */
  parentChat?: Readonly<{ chatType?: string; spawned: boolean }>;
  /** The CLI backend the job's model resolves to, when it runs on one. */
  cliBackend?: string;
};

function jobRef(job: CronStoredJob): JobRef {
  return { id: job.id, name: job.name?.trim() || job.id, enabled: job.enabled };
}

/**
 * Adds one job's findings to the report. A job can appear in several
 * categories, for example a CLI job whose parent has no chat type.
 */
export function classifyScheduledJob(
  report: ScheduledContextReport,
  observation: ScheduledJobObservation,
): void {
  const { job, facts, result } = observation;
  const ref = jobRef(job);
  // Command payloads run host commands without the parent's access and never pause.
  const runsCommand = job.payload.kind === "command";
  // Only a trigger script or a detached/custom-session run executes under the minted context;
  // a main-target job runs in the agent's own session, though a missing parent still pauses it.
  const usesContext = Boolean(job.trigger) || (!runsCommand && job.sessionTarget !== "main");
  if (result.status === "pause") {
    if (!runsCommand) {
      report.pauses.push({
        job: ref,
        parentSessionKey: result.parentSessionKey,
        cause: result.reason,
        ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
      });
    }
    return;
  }
  if (!usesContext) {
    return;
  }
  if (result.status === "fail") {
    report.failed.push({ job: ref, reason: result.error });
    return;
  }
  const { principal, authority } = result.facts;
  if (principal.kind === "unbound-parent") {
    // The builder demotes a reset parent link to unbound; the stored link tells them apart.
    const stored = resolveScheduledPrincipal(job, facts);
    const cause = "kind" in stored && stored.kind === "parent" ? "reset" : "key-only";
    report.unbound.push({ job: ref, parentSessionKey: principal.parentSessionKey, cause });
  }
  const lost = compareScheduledDecisions(job, facts, result).changes.filter(
    (change) => change.label === "loss",
  );
  if (lost.length > 0) {
    report.losses.push({ job: ref, fields: lost, ownerCheck: observation.ownerCheck });
  }
  // Scheduled CLI runs used to coerce the absent owner bit to false; an owner context now
  // gives them the owner-only tools their embedded runs already had.
  if (observation.cliBackend && authority.owner) {
    report.runtimeOwner.push({ job: ref, cliBackend: observation.cliBackend });
  }
  // Memory lineage reads the chat type from the root row; a spawned parent is not a root.
  const parentChat = observation.parentChat;
  if (principal.kind === "parent" && parentChat && !parentChat.spawned && !parentChat.chatType) {
    report.missingChatType.push({ job: ref, parentSessionKey: principal.parent.sessionKey });
  }
}

function label(job: JobRef) {
  return `${job.name} (${job.id})${job.enabled ? "" : " [disabled]"}`;
}

function describeLostField(change: LostField): string {
  switch (change.field) {
    case "ownerEmbedded":
      return "owner-only tools such as sessions, portal, nodes, gateway and plugins (the creator is not currently an owner)";
    case "automations":
      return `automations tool (${String(change.legacy)} -> ${String(change.context)})`;
    case "sandbox":
      return "unsandboxed execution (the creating conversation requires a sandbox)";
    case "admissionSource":
      return "operator admission";
    case "automationsCli":
      return "unscoped automations tool on CLI backends (now limited to this automation, as on embedded runs)";
    case "requesterYield":
      return "sessions_yield (scheduled runs cannot wait for child sessions; the run must finish its turn)";
    default:
      return change.field;
  }
}

const PAUSE_CAUSE: Record<ScheduledContextReport["pauses"][number]["cause"], string> = {
  removed: "was removed",
  archived: "is archived",
  "worktree-missing": "has a missing worktree",
};

// Each section is a heading line followed by one bullet per job.
function section(heading: string, lines: string[], footer?: string): string[] {
  return lines.length === 0 ? [] : [heading, ...lines, ...(footer ? [footer] : [])];
}

/** Doctor's note text for the report, or null when no job changes. */
export function formatScheduledContextReport(report: ScheduledContextReport): string | null {
  const lines = [
    ...section(
      `${pluralize(report.losses.length, "automation")} will lose access at the next run:`,
      report.losses.map(
        (entry) =>
          `- ${label(entry.job)}: ${entry.fields.map(describeLostField).join("; ")}${
            entry.ownerCheck === "unverified"
              ? " (the creator's owner status is checked at each run; Doctor could not verify it)"
              : ""
          }`,
      ),
    ),
    ...section(
      `${pluralize(report.pauses.length, "automation")} will pause at the next run because the conversation that created ${report.pauses.length === 1 ? "it" : "them"} is unavailable:`,
      report.pauses.map(
        (entry) =>
          `- ${label(entry.job)}: \`${entry.parentSessionKey}\` ${PAUSE_CAUSE[entry.cause]}${
            entry.worktreePath ? ` (\`${entry.worktreePath}\`)` : ""
          }`,
      ),
      `  Restore the conversation and run ${formatCliCommand("openclaw automations enable <id>")} after a pause, or recreate the automation from another conversation.`,
    ),
    ...section(
      `${pluralize(report.unbound.length, "automation")} ${report.unbound.length === 1 ? "is" : "are"} not bound to the conversation that created ${report.unbound.length === 1 ? "it" : "them"}:`,
      report.unbound.map(
        (entry) =>
          `- ${label(entry.job)}: \`${entry.parentSessionKey}\` ${
            entry.cause === "reset"
              ? "was reset after the automation was created"
              : "is recorded by key only"
          }`,
      ),
      "  These keep their current behavior and do not use the conversation's board, memory or workspace. Recreate one from its conversation to bind it.",
    ),
    ...section(
      `${pluralize(report.runtimeOwner.length, "automation")} ${report.runtimeOwner.length === 1 ? "runs" : "run"} on a CLI backend, where scheduled runs now get the owner-only tools embedded runs already had:`,
      report.runtimeOwner.map((entry) => `- ${label(entry.job)}: ${entry.cliBackend}`),
      "  Earlier versions gave these scheduled CLI runs no owner-only tools; both runtimes now read the same scheduled-run authority.",
    ),
    ...section(
      `${pluralize(report.missingChatType.length, "automation")} ${report.missingChatType.length === 1 ? "has" : "have"} a creating conversation with no stored chat type, so ${report.missingChatType.length === 1 ? "its" : "their"} runs get no conversation memory:`,
      report.missingChatType.map((entry) => `- ${label(entry.job)}: \`${entry.parentSessionKey}\``),
      "  Conversations created by OpenClaw 2026.10.6 or earlier did not record a chat type. A Doctor repair for these conversations is planned; nothing is changed here.",
    ),
    ...section(
      `${pluralize(report.failed.length, "automation")} could not be evaluated:`,
      report.failed.map((entry) => `- ${label(entry.job)}: ${entry.reason}`),
    ),
  ];
  if (lines.length === 0) {
    return null;
  }
  return ["Scheduled-run access review (read-only; nothing was changed).", ...lines].join("\n");
}
