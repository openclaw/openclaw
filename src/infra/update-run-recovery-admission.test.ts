import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

describe("package-only recovery admission", () => {
  it("admits absent state without creating it", async () => {
    const root = path.join(dirs.make("update-admission-"), "absent");
    await assertUpdateRecoveryAdmission({ env: { OPENCLAW_STATE_DIR: root } });
    expect(fs.existsSync(root)).toBe(false);
  });

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
