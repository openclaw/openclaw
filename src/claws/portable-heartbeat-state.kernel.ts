import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { readScratchStateFromDatabase } from "../cron/scratch-read.kernel.js";
import { hashCronScratchSource } from "../cron/scratch-store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import { loadCronRuntimeAuthorities } from "../cron/store/runtime-authority-store.js";
import { readClawHeartbeatRefInDatabase } from "./cron.js";
import { digestClawValue } from "./digest.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";

export function readPortableHeartbeatStateInDatabase(
  db: DatabaseSync,
  agentId: string,
  storePath: string,
): PortableHeartbeatState {
  const storeKey = cronStoreKey(storePath);
  const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  const jobs = receipt
    ? loadedCronStoreFromRows(loadCronRows(db, storeKey, new Set([receipt.jobId]))).store.jobs
    : [];
  loadCronRuntimeAuthorities({ db, storeKey, jobs });
  return {
    storePath,
    receipt,
    ref: readClawHeartbeatRefInDatabase(db, agentId),
    job: jobs[0],
    scratch: receipt
      ? readScratchStateFromDatabase(db, storeKey, receipt.jobId)
      : { currentRevision: 0 },
  };
}

export function portableHeartbeatStateDigest(state: PortableHeartbeatState): string {
  return digestClawValue({
    receipt: state.receipt,
    ref: state.ref,
    revision: state.job ? resolveCronJobConfigRevision(state.job) : undefined,
    scratchRevision: state.scratch.currentRevision,
    authority: state.job?.runtimeAuthority,
    authorityRecovery: state.job?.runtimeAuthorityRecoveryRequired,
  });
}

export function portableHeartbeatDrift(state: PortableHeartbeatState): boolean {
  return (
    !state.ref ||
    !state.receipt ||
    state.ref.schedulerJobId !== state.receipt.jobId ||
    state.ref.status !== "complete" ||
    state.receipt.phase !== "complete" ||
    !state.job ||
    Boolean(state.job.runtimeAuthority) ||
    state.job.runtimeAuthorityRecoveryRequired === true ||
    state.ref.job.configRevision !== resolveCronJobConfigRevision(state.job) ||
    state.ref.job.scratchDigest !==
      (state.scratch.scratch ? hashCronScratchSource(state.scratch.scratch.content) : undefined)
  );
}

export function assertPortableHeartbeatUnchanged(
  current: PortableHeartbeatState,
  expected: PortableHeartbeatState,
): void {
  if (
    current.storePath !== expected.storePath ||
    !isDeepStrictEqual(current.ref, expected.ref) ||
    !isDeepStrictEqual(current.receipt, expected.receipt) ||
    !isDeepStrictEqual(
      structuredClone(current.job?.runtimeAuthority),
      expected.job?.runtimeAuthority,
    ) ||
    current.job?.runtimeAuthorityRecoveryRequired !==
      expected.job?.runtimeAuthorityRecoveryRequired ||
    (current.job ? resolveCronJobConfigRevision(current.job) : undefined) !==
      (expected.job ? resolveCronJobConfigRevision(expected.job) : undefined) ||
    current.scratch.currentRevision !== expected.scratch.currentRevision
  ) {
    throw new Error(
      "Portable automation or scratch changed after planning; rebuild the Claw plan.",
    );
  }
}
