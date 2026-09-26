import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
/**
 * Durable follow-up queue storage, routed through the shared-state worker.
 *
 * Runtime enqueue and settlement used to open a synchronous write transaction on
 * the Gateway thread, so a contended database blocked unrelated agent and channel
 * work while the whole snapshot was rewritten. Every read and write now dispatches
 * to the canonical shared-state worker; the SQL itself lives in
 * `followup-queue-sqlite.kernel.ts`, which the worker handler calls.
 *
 * Admission rollback and FIFO settlement are preserved by awaiting each command:
 * the caller still learns whether the durable write succeeded before it decides to
 * keep or roll back the in-memory admission.
 */
import type { FollowupQueueEntryRow } from "./followup-queue-sqlite.contract.js";

function workerContext(stateDir?: string): OpenClawStateWorkerContext {
  // A caller-selected state root must never fall back to the process default.
  return captureOpenClawStateWorkerContext(
    stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {},
  );
}

export async function listFollowupQueueKeys(stateDir?: string): Promise<string[]> {
  return executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.listKeys",
    input: undefined,
  });
}

/**
 * Read one queue row. Resolves `undefined` when the key has no row; rejects when
 * the database cannot be read or the row is corrupt, so callers never mistake an
 * unreadable row for an absent one.
 */
export async function loadFollowupQueueEntry(
  queueKey: string,
  stateDir?: string,
): Promise<unknown> {
  const result = await executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.loadEntry",
    input: queueKey,
  });
  return result.found ? result.data : undefined;
}

export async function replaceFollowupQueueEntries(params: {
  entries: Array<[string, unknown]>;
  stateDir?: string;
  /** Keys that must survive even when they are absent from `entries` (unreadable rows). */
  retainKeys?: readonly string[];
}): Promise<void> {
  await executeOpenClawStateWorker(workerContext(params.stateDir), {
    type: "followupQueue.replace",
    input: { entries: params.entries, retainKeys: params.retainKeys },
  });
}

export async function loadFollowupQueueEntries(
  stateDir?: string,
): Promise<Array<[string, unknown]>> {
  const rows: FollowupQueueEntryRow[] = await executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.loadEntries",
    input: undefined,
  });
  return rows.map((row) => [row.queueKey, row.data]);
}

/** Keys whose `queue_json` cannot be parsed. Ordinary persist must retain these. */
export async function listUnreadableFollowupQueueKeys(stateDir?: string): Promise<string[]> {
  return executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.listUnreadableKeys",
    input: undefined,
  });
}

export async function hasFollowupQueueEntries(stateDir?: string): Promise<boolean> {
  return executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.hasEntries",
    input: undefined,
  });
}

/** Test-facing probe: does the stored snapshot for `queueKey` still contain `prompt`? */
export async function followupQueueEntryContainsPrompt(
  queueKey: string,
  prompt: string,
  stateDir?: string,
): Promise<boolean> {
  return executeOpenClawStateWorker(workerContext(stateDir), {
    type: "followupQueue.entryContainsPrompt",
    input: { queueKey, prompt },
  });
}
