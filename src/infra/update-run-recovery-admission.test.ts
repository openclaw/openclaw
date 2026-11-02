import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { useExecutorFixture } from "../cli/update-cli/update-command-executor.test-support.js";
import { assertUpdateCommandRecoveryState } from "../cli/update-cli/update-command-recovery.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";
import { recordUpdateRunPhaseAsync } from "./update-run-write.async.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const executorFixture = useExecutorFixture("update-cohort-admission-", {
  beforeCleanup: closeStateDatabaseForTest,
});
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());

describe("package-only recovery admission", () => {
  it("continues only its paired intent under the same live executor and source", async () => {
    const { root } = executorFixture();
    const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "profile") };
    const runId = randomUUID();
    const continuation = await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      createUpdateRun({ runId, trigger: "cli" }, { env });
      const runtime = {
        root,
        nodePath: process.execPath,
        version: "2026.10.9",
        buildId: "fixture",
      };
      // Synthetic retained storage; the executor and worker admission remain real.
      const reservation = createRetainedUpdateRecovery(
        { runId, from: runtime, to: runtime },
        { env },
      );
      writeConfigMachineState(
        "update.pluginCohort." + runId,
        {
          runId,
          transactionId: reservation.transactionId,
          revision: 0,
          disposition: "pending",
          installKey: root,
          priorArtifacts: [],
          artifacts: [],
          publications: [],
          settledPublications: 0,
        },
        { env },
      );
      const pluginCohort = { runId, fence };
      await expect(assertUpdateRecoveryAdmission({ env })).rejects.toThrow("unfinished recovery");
      await expect(
        assertUpdateRecoveryAdmission({
          env,
          pluginCohort: { runId, fence: { assertCurrent() {} } },
        }),
      ).rejects.toThrow("admitted executor");
      await expect(
        assertUpdateRecoveryAdmission({
          env: { ...env, OPENCLAW_CONFIG_PATH: path.join(root, "other.json") },
          pluginCohort,
        }),
      ).rejects.toThrow("unfinished recovery");
      await expect(assertUpdateRecoveryAdmission({ env, pluginCohort })).resolves.toBeUndefined();
      expect(() =>
        assertUpdateCommandRecoveryState({ run: { runId, env, executorFence: fence } }),
      ).not.toThrow();
      await recordUpdateRunPhaseAsync(
        runId,
        "validating",
        {},
        {
          env,
          requireNoRecovery: true,
          pluginCohort,
        },
      );
      expect(getUpdateRun(runId, { env })?.phase).toBe("validating");
      return pluginCohort;
    });
    await expect(
      assertUpdateRecoveryAdmission({ env, pluginCohort: continuation }),
    ).rejects.toThrow("no longer current");
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
import { randomUUID } from "node:crypto";
