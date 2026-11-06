import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as snapshots from "./sqlite-snapshot-source.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());

describe("package-only recovery admission", () => {
  it("runs host recovery guards without copying the database", () => {
    const f = createRetainedCheckpointFixture(dirs.make("update-guard-copies-"));
    const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    for (let check = 0; check < 3; check += 1) {
      expect(() =>
        assertNoPendingUpdateRecovery({ ...f.options, allowNativeRead: true }),
      ).toThrowError(expect.objectContaining({ name: "UpdateRecoveryRequiredError" }));
    }
    expect(copies).not.toHaveBeenCalled();
  });

  it("admits absent state without creating it", async () => {
    const root = path.join(dirs.make("update-admission-"), "absent");
    await assertUpdateRecoveryAdmission({ env: { OPENCLAW_STATE_DIR: root } });
    expect(fs.existsSync(root)).toBe(false);
  });

  it.each([false, true])(
    "keeps the selected recovery directory and file together (explicit path=%s)",
    async (explicitPath) => {
      const f = createRetainedCheckpointFixture(dirs.make("update-admission-target-"));
      const replacement = path.join(dirs.make("update-admission-replacement-"), "absent");
      const before = fs.readFileSync(f.file);
      let changed = false;
      const lstat = asyncFs.lstat.bind(asyncFs);
      vi.spyOn(asyncFs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (String(args[0]) === path.dirname(f.file)) {
          changed = true;
          f.env.OPENCLAW_STATE_DIR = replacement;
        }
        return result;
      });
      await expect(
        assertUpdateRecoveryAdmission(explicitPath ? { ...f.options, path: f.file } : f.options),
      ).rejects.toMatchObject({
        name: "UpdateRecoveryRequiredError",
        record: { runId: f.run.runId },
      });
      expect(changed).toBe(true);
      expect(fs.readFileSync(f.file).equals(before)).toBe(true);
      expect(fs.existsSync(replacement)).toBe(false);
    },
  );

  it.each(["sealed", "unsealed", "displaced", "orphan beside canonical"] as const)(
    "refuses %s checkpoint state without changing retained bytes",
    async (kind) => {
      const f = createRetainedCheckpointFixture(
        dirs.make("update-admission-"),
        kind !== "unsealed",
      );
      if (kind === "displaced" || kind === "orphan beside canonical") {
        f.displace();
      }
      const freshRun =
        kind === "orphan beside canonical"
          ? createUpdateRun({ trigger: "cli" }, f.options)
          : undefined;
      closeOpenClawStateDatabaseForTest();
      const files = [
        f.file,
        f.displaced,
        f.record.checkpoint!.ref.manifestPath,
        f.record.restore!.planPath,
      ];
      const snapshot = () =>
        files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      const before = snapshot();
      await expect(assertUpdateRecoveryAdmission(f.options)).rejects.toThrow(
        /recovery|publication/i,
      );
      const after = snapshot();
      expect(after).toHaveLength(before.length);
      for (const [index, bytes] of before.entries()) {
        if (bytes === null) {
          expect(after[index]).toBeNull();
        } else {
          expect(after[index]?.equals(bytes)).toBe(true);
        }
      }
      if (freshRun) {
        expect(getUpdateRun(freshRun.runId, f.options)).toEqual(freshRun);
      }
    },
  );
});
