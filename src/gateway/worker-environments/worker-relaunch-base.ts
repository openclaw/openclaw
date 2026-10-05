import { recordModelFallbackStop } from "../../agents/failover-error.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";

export type WorkerRelaunchSuffixClassification =
  | { kind: "at-admission" }
  | { kind: "self-terminal-error"; baseLeafId: string }
  | { kind: "self-tool-activity" }
  | { kind: "foreign" };

type BranchEntry = ReturnType<SessionManager["getBranch"]>[number];

function readCommittedRunId(entry: BranchEntry): string | undefined {
  if (entry.type !== "message") {
    return undefined;
  }
  const metadata = Reflect.get(entry.message, "__openclaw");
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const runId = Reflect.get(metadata, "runId");
  return typeof runId === "string" && runId ? runId : undefined;
}

// A committed assistant toolCall is replay-unsafe on its own, even before
// its result lands: a fallback relaunch that built on it would re-execute
// the call, so any committed tool activity — result or bare call — stops
// the relaunch.
function commitsToolActivity(
  message: Extract<BranchEntry, { type: "message" }>["message"],
): boolean {
  if (message.role === "toolResult") {
    return true;
  }
  if (message.role !== "assistant") {
    return false;
  }
  return message.content.some((part) => part.type === "toolCall");
}

/**
 * Classify the transcript suffix a model-fallback relaunch would otherwise
 * pin its commit base over. The strict commit-side prefix check stays the
 * authority: anything not provably this run's own output must keep being
 * refused, so an unattributable suffix classifies as foreign. Only a
 * same-run tail without tool activity is safe to build on, because it can
 * carry no side effects worth replaying.
 */
function classifyWorkerRelaunchSuffix(params: {
  branch: readonly BranchEntry[];
  admissionEntryId: string;
  runId: string;
}): WorkerRelaunchSuffixClassification {
  const admissionIndex = params.branch.findIndex((entry) => entry.id === params.admissionEntryId);
  if (admissionIndex < 0) {
    return { kind: "foreign" };
  }
  const suffix = params.branch.slice(admissionIndex + 1);
  if (suffix.length === 0) {
    return { kind: "at-admission" };
  }
  let sawToolActivity = false;
  let lastMessage: Extract<BranchEntry, { type: "message" }> | undefined;
  for (const entry of suffix) {
    if (entry.type !== "message" || readCommittedRunId(entry) !== params.runId) {
      return { kind: "foreign" };
    }
    if (commitsToolActivity(entry.message)) {
      sawToolActivity = true;
    }
    lastMessage = entry;
  }
  if (sawToolActivity) {
    return { kind: "self-tool-activity" };
  }
  if (!lastMessage || lastMessage.message.role !== "assistant") {
    return { kind: "foreign" };
  }
  return { kind: "self-terminal-error", baseLeafId: lastMessage.id };
}

/**
 * Read the durable transcript and classify what moved past the admission
 * since the shared recorder persisted it. Detached from the admission-fenced
 * model context on purpose: the relaunch base must follow the durable leaf,
 * not the fenced prefix.
 */
export async function resolveWorkerRelaunchBase(params: {
  transcriptTarget: SessionTranscriptRuntimeTarget;
  admissionEntryId: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<WorkerRelaunchSuffixClassification> {
  let truncated = false;
  const durable = await SessionManager.openBoundedAsync(params.transcriptTarget, {
    maxBytes: 1024 * 1024,
    maxEvents: 100,
    onTruncated: () => {
      truncated = true;
    },
    ...(params.signal ? { signal: params.signal } : {}),
  });
  // A bounded cut only hides history older than the retained window, so once
  // the admission sits inside the window the suffix after it is complete and
  // classifies normally. Only a cut that hides the admission itself must keep
  // the strict refusal: an unattributable window stays fenced at the
  // admission base.
  const branch = durable.getBranch();
  if (truncated && !branch.some((entry) => entry.id === params.admissionEntryId)) {
    return { kind: "foreign" };
  }
  return classifyWorkerRelaunchSuffix({
    branch,
    admissionEntryId: params.admissionEntryId,
    runId: params.runId,
  });
}

/**
 * Rebase a model-fallback relaunch onto the durable transcript leaf. A
 * recorder whose admission persisted before this launch marks a fallback
 * relaunch: the failed candidate may have committed past that admission, so
 * the launch base must follow the durable leaf instead of the fenced prefix.
 * Returns the effective base leaf id, or the recorded refusal when the
 * failed candidate committed replay-unsafe tool activity.
 */
export async function applyWorkerModelFallbackRelaunch(params: {
  transcriptTarget: SessionTranscriptRuntimeTarget;
  admissionEntryId: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<
  { kind: "proceed"; baseLeafId?: string } | { kind: "stopped"; refusal: WorkerTurnExecutionError }
> {
  const relaunch = await resolveWorkerRelaunchBase(params);
  if (relaunch.kind === "self-tool-activity") {
    // Tool activity is a side effect: replaying the turn would run it twice
    // and write a second incompatible history, so fallback stops here.
    const refusal = new WorkerTurnExecutionError(
      "Cloud worker fallback candidate refused: the failed candidate already committed tool activity for this run",
    );
    recordModelFallbackStop(refusal);
    return { kind: "stopped", refusal };
  }
  if (relaunch.kind === "self-terminal-error") {
    return { kind: "proceed", baseLeafId: relaunch.baseLeafId };
  }
  return { kind: "proceed" };
}
