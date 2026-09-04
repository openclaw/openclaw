import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { loadCronRows, loadCronRowsByIds, replaceCronRows } from "./row-codec.js";

function makeJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

async function withStore(
  jobs: CronJob[],
  fn: (db: ReturnType<typeof openOpenClawStateDatabase>["db"], storeKey: string) => void,
) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-targeted-load-"));
  const handle = openOpenClawStateDatabase({ path: path.join(fixtureRoot, "state.sqlite") });
  const storeKey = cronStoreKey(handle.path);
  try {
    replaceCronRows(handle.db, storeKey, { version: 1, jobs });
    fn(handle.db, storeKey);
  } finally {
    handle.walMaintenance.close();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("loadCronRowsByIds targeted loader", () => {
  it.each([
    ["single id", ["job-2"]],
    ["subset of ids", ["job-1", "job-3"]],
    ["all ids", ["job-1", "job-2", "job-3"]],
  ])("returns only the requested rows for %s", async (_label, ids: string[]) => {
    const jobs = [makeJob("job-1"), makeJob("job-2"), makeJob("job-3")];
    await withStore(jobs, (db, storeKey) => {
      const rows = loadCronRowsByIds(db, storeKey, ids);
      expect(new Set(rows.map((r) => r.job_id))).toEqual(new Set(ids));
      expect(loadCronRows(db, storeKey).length).toBe(3);
    });
  });

  it("preserves store sort order even when ids are requested out of order", async () => {
    const jobs = [makeJob("alpha"), makeJob("beta"), makeJob("gamma")];
    await withStore(jobs, (db, storeKey) => {
      const rows = loadCronRowsByIds(db, storeKey, ["gamma", "alpha"]);
      expect(rows.map((r) => r.job_id)).toEqual(["alpha", "gamma"]);
    });
  });

  it("returns rows identical to a full-scan filter (parity invariant)", async () => {
    const jobs = [makeJob("job-1"), makeJob("job-2"), makeJob("job-3"), makeJob("job-4")];
    await withStore(jobs, (db, storeKey) => {
      const requested = ["job-4", "job-1", "job-2"];
      const targeted = loadCronRowsByIds(db, storeKey, requested);
      const filtered = loadCronRows(db, storeKey).filter((r) => requested.includes(r.job_id));
      expect(targeted).toEqual(filtered);
    });
  });

  it("deduplicates repeated ids", async () => {
    const jobs = [makeJob("job-1"), makeJob("job-2")];
    await withStore(jobs, (db, storeKey) => {
      const rows = loadCronRowsByIds(db, storeKey, ["job-1", "job-1", "job-2", "job-1"]);
      expect(rows.map((r) => r.job_id)).toEqual(["job-1", "job-2"]);
    });
  });

  it("returns an empty array for an empty id set", async () => {
    await withStore([makeJob("job-1")], (db, storeKey) => {
      expect(loadCronRowsByIds(db, storeKey, [])).toEqual([]);
    });
  });

  it("returns an empty array when none of the requested ids exist", async () => {
    await withStore([makeJob("job-1")], (db, storeKey) => {
      expect(loadCronRowsByIds(db, storeKey, ["missing-1", "missing-2"])).toEqual([]);
    });
  });

  it("falls back to a full scan when the id set exceeds the IN-list limit", async () => {
    const jobCount = 501;
    const jobs = Array.from({ length: jobCount }, (_, i) => makeJob(`job-${i}`));
    await withStore(jobs, (db, storeKey) => {
      const requested = jobs.map((job) => job.id);
      const targeted = loadCronRowsByIds(db, storeKey, requested);
      const filtered = loadCronRows(db, storeKey).filter((row) =>
        new Set(requested).has(row.job_id),
      );
      expect(targeted).toEqual(filtered);
      expect(targeted.length).toBe(jobCount);
    });
  });

  it("uses the indexed IN query for a set at the limit boundary", async () => {
    const jobCount = 500;
    const jobs = Array.from({ length: jobCount }, (_, i) => makeJob(`job-${i}`));
    await withStore(jobs, (db, storeKey) => {
      const requested = jobs.map((job) => job.id);
      const targeted = loadCronRowsByIds(db, storeKey, requested);
      expect(targeted.length).toBe(jobCount);
      expect(targeted.map((r) => r.job_id)).toEqual(requested);
    });
  });
});
