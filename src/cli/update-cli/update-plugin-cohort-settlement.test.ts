import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withPluginCohortConfigCapture } from "../../config/plugin-cohort-recovery.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import { resolvePackageActivationAnchor } from "../../infra/package-update-activation-paths.js";
import type { PluginCohortRecovery } from "../../infra/update-plugin-cohort-schema.js";
import { createUpdateRun, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { inspectPluginCohortRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  loadPluginCohortRecovery,
  writePluginCohortRecovery,
} from "../../infra/update-run-recovery-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { settleInterruptedUpdatePluginCohort } from "./update-plugin-cohort-settlement.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const fence = { assertCurrent() {} };
const original = { version: "2026.10.10", buildId: "2026.10.9-original" };
const candidate = { version: "2026.10.10", buildId: "2026.10.10-candidate" };
const obligation = {
  pluginId: "discord",
  requiresStateMigration: true as const,
  reason: "Package convergence must wait until the updating parent releases its install records.",
  command: "openclaw update repair",
};
const SUPERSEDED = "Plugin migration obligation changed after update publication: discord";

function installCore(root: string, identity: { version: string; buildId: string | null }) {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: identity.version }),
  );
  if (identity.buildId !== null) {
    fs.writeFileSync(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ buildId: identity.buildId }),
    );
  }
}

/**
 * An activated update reopened a plugin obligation, then failed after activation.
 * The candidate's Doctor later completed that obligation, superseding the publication.
 */
async function supersededCohort(params: {
  installed: { version: string; buildId: string | null };
  servedCandidate: boolean;
  recorded?: { disposition: "rollback"; settledPublications: 0 | 1 };
  pendingPackageRecovery?: true;
}) {
  const stateDir = dirs.make("cohort-settlement-state-");
  const root = path.join(dirs.make("cohort-settlement-install-"), "openclaw");
  installCore(root, params.installed);
  if (params.pendingPackageRecovery) {
    // A package activation record keeps its own authority to restore the original core.
    fs.mkdirSync(resolvePackageActivationAnchor(root));
  }
  const options = { env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  if (params.servedCandidate) {
    recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        runningVersion: candidate.version,
        runningBuildId: candidate.buildId,
        readyz: true,
        settled: true,
      },
      options,
    );
  }
  await recordDeferredPluginMigrations({
    env: options.env,
    pending: [],
    settlements: [{ pluginId: obligation.pluginId, status: "completed", reason: "settled" }],
  });
  const reservation: UpdateRecoveryRecord = {
    runId: run.runId,
    transactionId: randomUUID(),
    revision: 0,
    claimId: randomUUID(),
    claimKind: "initial",
    handoff: null,
    source: { stateDir, configPath: path.join(stateDir, "openclaw.json") },
    from: { root, nodePath: process.execPath, ...original },
    to: { root, nodePath: process.execPath, ...candidate },
    createdAtMs: 1,
    updatedAtMs: 1,
    effects: [],
    restore: null,
    verification: null,
    primaryFailure: null,
  };
  const cohort: PluginCohortRecovery = {
    runId: run.runId,
    transactionId: reservation.transactionId,
    revision: 0,
    disposition: "pending",
    installKey: root,
    priorArtifacts: [],
    artifacts: [],
    publications: [],
    settledPublications: 0,
  };
  beginPluginCohortRecovery(reservation, cohort, fence, options);
  // The updater reopens the obligation while its parent still owns install records.
  await withPluginCohortConfigCapture(
    { runId: run.runId, installKey: root, env: options.env, ...fence },
    () => recordDeferredPluginMigrations({ env: options.env, pending: [obligation] }),
  );
  if (params.recorded) {
    // An earlier repair selected rollback, then refused the superseded obligation.
    const pair = loadPluginCohortRecovery(run.runId, options)!;
    writePluginCohortRecovery(pair, { ...pair.cohort, ...params.recorded }, fence, options);
  }
  await recordDeferredPluginMigrations({
    env: options.env,
    pending: [],
    settlements: [
      { pluginId: obligation.pluginId, status: "completed", reason: "candidate completed" },
    ],
  });
  await closeOpenClawStateDatabaseAsync();
  const row = () =>
    openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT started_at, finished_at, status, report_json FROM migration_runs WHERE id = ?",
      )
      .get(`deferred-plugin-migration:${obligation.pluginId}`);
  const later = row();
  expect(later).toMatchObject({ status: "completed" });
  const settle = async () => {
    const expected = await inspectPluginCohortRecoveryAdmission(options, run.runId);
    if (!expected) {
      throw new Error("Expected the retained plugin cohort to require repair");
    }
    await settleInterruptedUpdatePluginCohort({
      expected,
      root,
      options,
      assertCurrent: () => fence.assertCurrent(),
    });
  };
  return { options, runId: run.runId, row, later, settle };
}

it.each([
  ["pending", candidate, undefined],
  ["refused rollback", candidate, { disposition: "rollback", settledPublications: 0 }],
  // Deploying a repair build replaces the candidate's build ID but not the original's absence.
  [
    "refused rollback under a later build",
    { version: candidate.version, buildId: "2026.10.11-repair" },
    { disposition: "rollback", settledPublications: 0 },
  ],
] as const)(
  "settles a %s cohort forward once its candidate verified serving",
  async (_label, installed, recorded) => {
    const f = await supersededCohort({ installed, servedCandidate: true, recorded });
    await f.settle();
    expect(loadPluginCohortRecovery(f.runId, f.options)).toBeUndefined();
    expect(await inspectPluginCohortRecoveryAdmission(f.options)).toBeUndefined();
    expect(f.row()).toEqual(f.later);
  },
);

it.each([
  ["the original core is installed", { installed: original, servedCandidate: true }],
  [
    "the original version has no readable build",
    { installed: { version: original.version, buildId: null }, servedCandidate: true },
  ],
  ["the candidate never verified serving", { installed: candidate, servedCandidate: false }],
  [
    "a package activation record remains",
    { installed: candidate, servedCandidate: true, pendingPackageRecovery: true },
  ],
  [
    "rollback already settled a publication",
    {
      installed: candidate,
      servedCandidate: true,
      recorded: { disposition: "rollback", settledPublications: 1 },
    },
  ],
] as const)("keeps refusing a superseded rollback when %s", async (_label, shape) => {
  const f = await supersededCohort(shape);
  await expect(f.settle()).rejects.toThrow(SUPERSEDED);
  expect(loadPluginCohortRecovery(f.runId, f.options)?.cohort.disposition).toBe("rollback");
  expect(f.row()).toEqual(f.later);
});
