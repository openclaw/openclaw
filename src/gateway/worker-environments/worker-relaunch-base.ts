import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";

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

/**
 * Classify the transcript suffix a model-fallback relaunch would otherwise
 * pin its commit base over. The strict commit-side prefix check stays the
 * authority: anything not provably this run's own output must keep being
 * refused, so an unattributable suffix classifies as foreign. Only a
 * same-run tail without tool activity is safe to build on, because it can
 * carry no side effects worth replaying.
 */
export function classifyWorkerRelaunchSuffix(params: {
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
    if (entry.message.role === "toolResult") {
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
  const durable = await SessionManager.openAsync(
    params.transcriptTarget,
    undefined,
    undefined,
    params.signal,
  );
  return classifyWorkerRelaunchSuffix({
    branch: durable.getBranch(),
    admissionEntryId: params.admissionEntryId,
    runId: params.runId,
  });
}
