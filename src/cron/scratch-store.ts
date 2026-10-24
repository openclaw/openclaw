/** Database-backed per-job scratch storage, kept outside public cron job state. */
import { createHash } from "node:crypto";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { captureCronMutationCommit } from "./mutation-completion.js";
import {
  assertCronJobScratchContent,
  type CronJobScratchState,
  type CronJobScratchWriteResult,
} from "./scratch-contract.js";
import { readScratchStateFromDatabase } from "./scratch-read.kernel.js";
import { runCronRuntimeMutation } from "./service/runtime-mutation.js";
import { cronStoreKey } from "./store/key.js";

/** Doctor's synchronous transaction reads stay with the maintenance owner. */
export function readCronJobScratchState(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
): CronJobScratchState {
  const { db } = openOpenClawStateDatabase(options);
  return readScratchStateFromDatabase(db, cronStoreKey(storePath), jobId);
}

/** Writes through the existing actor while retaining the original caller's admission. */
export async function writeCronJobScratch(
  params: {
    storePath: string;
    jobId: string;
    content: string | null;
    expectedRevision?: number;
    sourceSha256?: string;
    nowMs?: number;
    options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  },
  admission?: {
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    expectedConfigRevision?: string;
    createdAtMsFallback?: number;
  },
): Promise<CronJobScratchWriteResult> {
  if (params.content !== null) {
    assertCronJobScratchContent(params.content);
  }
  const context = admission?.context ?? captureOpenClawStateWorkerContext(params.options);
  const markCommitted = captureCronMutationCommit("cron.scratch.set");
  let result: CronJobScratchWriteResult | undefined;
  await runCronRuntimeMutation({
    context,
    type: "cron.writeScratch",
    input: {
      storeKey: cronStoreKey(params.storePath),
      jobId: params.jobId,
      content: params.content,
      expectedRevision: params.expectedRevision,
      sourceSha256: params.sourceSha256,
      nowMs: params.nowMs ?? Date.now(),
      createdAtMsFallback: admission?.createdAtMsFallback,
    },
    assertCurrent: () => admission?.assertCurrent?.(),
    // Caller authority may retire after dispatch; the worker checks the captured job revision.
    snapshot: { expectedConfigRevision: admission?.expectedConfigRevision },
    publish(outcome) {
      result = outcome.result;
      if (outcome.written) {
        markCommitted?.();
      }
    },
  });
  if (!result) {
    throw new Error("Cron scratch write has no committed result");
  }
  return result;
}

/** Hash used by doctor to prove the file it removes is the file it migrated. */
export function hashCronScratchSource(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
