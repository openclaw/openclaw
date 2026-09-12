import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());

describe("package-only recovery admission", () => {
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
      expect(fs.readFileSync(f.file)).toEqual(before);
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
      expect(snapshot()).toEqual(before);
      if (freshRun) {
        expect(getUpdateRun(freshRun.runId, f.options)).toEqual(freshRun);
      }
    },
  );
});
