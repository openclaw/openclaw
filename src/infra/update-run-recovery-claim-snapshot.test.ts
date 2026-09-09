import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as snapshots from "./sqlite-readonly-location.js";
import { createUpdateRun } from "./update-run-ledger.js";
import {
  assertExactUpdateRecoveryClaim,
  beginUpdateRecovery,
  claimUpdateRecovery,
  prepareUpdateRecoveryHandoff,
} from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each(["current", "stale", "contents", "prepared", "retired"] as const)(
  "checks an exact claim in one artifact-preserving snapshot (%s)",
  (mode) => {
    // This test owns every writer of its disposable root. Real SQLite snapshots
    // must preserve source artifacts and keep both claim predicates together.
    const root = dirs.make("recovery-claim-snapshot-");
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const options = { env };
    let active = true;
    const fence = {
      assertCurrent() {
        if (!active) {
          throw new Error("owner retired");
        }
      },
    };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const from = {
      root: path.join(root, "old"),
      nodePath: process.execPath,
      version: "1.0.0",
      buildId: "old",
    };
    let expected = beginUpdateRecovery(
      { runId: run.runId, from, to: { ...from, version: "2.0.0", buildId: "new" } },
      fence,
      options,
    );
    if (mode === "stale") {
      claimUpdateRecovery(expected, fence, options);
    } else if (mode === "contents") {
      expected = { ...expected, to: { ...expected.to, version: "wrong" } };
    } else if (mode === "prepared") {
      expected = prepareUpdateRecoveryHandoff(expected, fence, options).record;
    }
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const artifacts = () =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => {
        const file = databasePath + suffix;
        if (!fs.existsSync(file)) {
          return null;
        }
        const stat = fs.statSync(file);
        return {
          suffix,
          ino: stat.ino,
          mtime: stat.mtimeMs,
          sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        };
      });
    const before = artifacts();
    const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
    const read = vi
      .spyOn(snapshots, "prepareSqliteReadOnlyLocationSync")
      .mockImplementation((...args) => {
        const location = prepare(...args);
        if (mode === "retired") {
          active = false;
        }
        return location;
      });
    const operation = () => assertExactUpdateRecoveryClaim(expected, fence, options);
    if (mode === "current") {
      expect(operation).not.toThrow();
    } else if (mode === "retired") {
      expect(operation).toThrow("owner retired");
    } else {
      expect(operation).toThrow();
    }
    // Each canonical snapshot launches a private SQLite reader; duplicating it
    // per native query can consume the bounded failed-start observation interval.
    expect(read).toHaveBeenCalledTimes(1);
    expect(artifacts()).toEqual(before);
  },
);
