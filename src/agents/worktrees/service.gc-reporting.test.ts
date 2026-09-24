import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backoff from "../../infra/backoff.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as leaseAcquisition from "../../state/openclaw-state-lease-acquisition.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { directorySizeBytes } from "./capacity.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

describe("GC final reporting authority", () => {
  const temporary = useAutoCleanupTempDirTracker(afterEach);
  const initializeRepository = useManagedWorktreeTestRepository();

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { kind: "count", over: false },
    { kind: "size", over: false },
    { kind: "count", over: true },
    { kind: "size", over: true },
  ] as const)(
    "defers $kind reporting when its lease is held, but continues snapshot expiry (over=$over)",
    async ({ kind, over }) => {
      const root = await fs.realpath(temporary.make("openclaw-gc-reporting-"));
      const repo = await initializeRepository(root);
      const stateDir = path.join(root, "state");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      let now = 1_700_000_000_000;
      const service = new ManagedWorktreeService({ env, now: () => now });
      const materialize = (name: string) =>
        materializeManagedWorktreeFixture({ env, name, now, repoRoot: repo, stateDir });
      const expired = await materialize("expired");
      const removed = await service.remove({ id: expired.id, reason: "retention" });
      now += SNAPSHOT_RETENTION_MS + 1;
      const survivor = await materialize("manual-survivor");
      const limits =
        kind === "count"
          ? { maxCount: over ? 0 : 1 }
          : { maxTotalSizeBytes: over ? 0 : await directorySizeBytes(survivor.path) };
      const acquired = createDeferred();
      const release = createDeferred();
      const holder = withWorktreeAllocationLease({ env }, async (guard) => {
        acquired.resolve();
        await release.promise;
        guard.commitGuard?.();
      });
      try {
        await Promise.race([
          acquired.promise,
          holder.then(() => {
            throw new Error("Holder did not acquire allocation authority");
          }),
        ]);
        // Advance only acquisition's monotonic deadline, not the real holder's
        // wall-clock expiry. No ten-minute sleep or fabricated lease error.
        const realNow = performance.now.bind(performance);
        let elapsedMs = 0;
        vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsedMs);
        const wait = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
          elapsedMs += 10 * 60_000 + 1;
        });
        const acquire = leaseAcquisition.acquireOpenClawStateLease;
        let held = false;
        vi.spyOn(leaseAcquisition, "acquireOpenClawStateLease").mockImplementation(
          async (params) => {
            try {
              await acquire(params);
            } catch (error) {
              expect(error).toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
              held = true;
              // Release only after actual contention exhausted acquisition. The
              // later snapshot-maintenance phase can then acquire its own lease.
              release.resolve();
              await holder;
              throw error;
            }
          },
        );

        const result = await service.gc({ limits });

        expect(held).toBe(true);
        expect(wait).toHaveBeenCalled();
        expect(result).toMatchObject({
          removed: [],
          outcome: "deferred",
          limitsSatisfied: null,
          snapshotsPruned: 1,
        });
        expect(result.issues).toContainEqual(
          expect.objectContaining({ stage: "limits", outcome: "deferred" }),
        );
        expect(getRegistryWorktree(env, survivor.id)?.removedAt).toBeUndefined();
        expect(await fs.readFile(path.join(survivor.path, "README.md"), "utf8")).toBe("base\n");
        expect(getRegistryWorktree(env, expired.id)).toBeUndefined();
        await expect(
          execFileAsync("git", ["-C", repo, "show-ref", "--verify", removed.snapshotRef!]),
        ).rejects.toThrow();
      } finally {
        release.resolve();
        await holder;
      }
    },
  );
});
