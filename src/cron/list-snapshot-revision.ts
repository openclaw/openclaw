import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import type { CronJob } from "./types.js";

type CronListSnapshotRow = { job: CronJob; revision: string };

/** Reconcile published rows against detached snapshots, including in-place runtime edits. */
export function resolveCronListSnapshotRows(
  jobs: readonly CronJob[],
  previous?: ReadonlyMap<string, CronListSnapshotRow>,
): Map<string, CronListSnapshotRow> {
  return new Map(
    jobs.map((job) => {
      const cached = previous?.get(job.id);
      return [
        job.id,
        cached && isDeepStrictEqual(cached.job, job)
          ? cached
          : {
              job: freezeTrustedJsonSnapshot(structuredClone(job)),
              revision: sha256StableValue(job).digest,
            },
      ];
    }),
  );
}

export function resolveCronListSnapshotRevision(
  jobs: readonly CronJob[],
  rows: ReadonlyMap<string, CronListSnapshotRow>,
): string {
  // Ordered, fixed-width row digests cover off-page changes without rehashing payloads.
  const hash = createHash("sha256");
  for (const job of jobs) {
    hash.update(rows.get(job.id)!.revision);
  }
  return `sha256:${hash.digest("base64url")}`;
}
