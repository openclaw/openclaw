import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.factory.js";
import { replaceConfigFile } from "../../config/mutate.js";
import * as configRecovery from "../../config/plugin-cohort-recovery.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-paths.js";
import { settlePendingPackageActivation } from "../../infra/package-update-activation.js";
import type { PluginCohortRecovery } from "../../infra/update-plugin-cohort-schema.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { inspectPluginCohortRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery-schema.js";
import * as recoveryStore from "../../infra/update-run-recovery-store.js";
import {
  beginPluginCohortRecovery,
  loadPluginCohortRecovery,
  writePluginCohortRecovery,
} from "../../infra/update-run-recovery-store.js";
import { updateRunWarningMessages } from "../../infra/update-run-step.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createInterruptedPackagePublication } from "./update-package-publication.test-support.js";
import { settleInterruptedUpdatePluginCohort } from "./update-plugin-cohort-settlement.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});
const fence = { assertCurrent() {} };
type Core = { version: string; buildId: string | null };
const original: Core = { version: "2026.10.10", buildId: "2026.10.9-original" };
const candidate: Core = { version: "2026.10.10", buildId: "2026.10.10-candidate" };
const obligation = {
  pluginId: "discord",
  requiresStateMigration: true as const,
  reason: "Package convergence must wait until the updating parent releases its install records.",
  command: "openclaw update repair",
};
// Only rollback restores, so only rollback can keep the later decision and warn.
const KEPT_OBLIGATION = "plugin discord data/settings upgrade obligation";

function installCore(root: string, identity: Core) {
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
 * An activated update reopened a completed plugin obligation, and optionally
 * changed config, before failing. Its plugin cohort is still pending.
 */
async function interruptedCohort(params: { root: string; from?: Core; to?: Core; config?: true }) {
  const { root, from = original, to = candidate } = params;
  const stateDir = dirs.make("cohort-settlement-state-");
  const configPath = path.join(stateDir, "openclaw.json");
  const options = { env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, NODE_ENV: "test" } };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const beforeConfig = json({ gateway: { mode: "local", port: 18789 } });
  fs.writeFileSync(configPath, beforeConfig);
  // The original core had already completed this obligation.
  await recordDeferredPluginMigrations({ env: options.env, pending: [obligation] });
  await recordDeferredPluginMigrations({
    env: options.env,
    pending: [],
    settlements: [{ pluginId: obligation.pluginId, status: "completed", reason: "original" }],
  });
  await closeOpenClawStateDatabaseAsync();
  const row = () =>
    openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT started_at, finished_at, status, report_json FROM migration_runs WHERE id = ?",
      )
      .get(`deferred-plugin-migration:${obligation.pluginId}`);
  const beforeRow = row();
  const run = createUpdateRun({ trigger: "cli" }, options);
  const reservation: UpdateRecoveryRecord = {
    runId: run.runId,
    transactionId: randomUUID(),
    revision: 0,
    claimId: randomUUID(),
    claimKind: "initial",
    handoff: null,
    source: { stateDir, configPath },
    from: { root, nodePath: process.execPath, ...from },
    to: { root, nodePath: process.execPath, ...to },
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
  const io = createConfigIO({
    env: options.env,
    configPath,
    observe: false,
    pluginValidation: "skip",
  });
  await configRecovery.withPluginCohortConfigCapture(
    { runId: run.runId, installKey: root, env: options.env, ...fence },
    async () => {
      // The updater reopens the obligation while its parent still owns install records.
      await recordDeferredPluginMigrations({ env: options.env, pending: [obligation] });
      if (params.config) {
        const prepared = await io.readConfigFileSnapshotForWrite();
        await replaceConfigFile({
          snapshot: prepared.snapshot,
          sourceConfig: { ...prepared.snapshot.sourceConfig, gateway: { mode: "local", port: 1 } },
          writeOptions: { ...prepared.writeOptions, skipPluginValidation: true },
          io: {
            env: options.env,
            readConfigFileSnapshotForWrite: io.readConfigFileSnapshotForWrite,
            writeConfigFile: io.writeConfigFile,
          },
        });
      }
    },
  );
  await closeOpenClawStateDatabaseAsync();
  const afterConfig = fs.readFileSync(configPath, "utf8");
  return {
    options,
    runId: run.runId,
    configPath,
    beforeConfig,
    afterConfig,
    beforeRow,
    row,
    cohort: () => loadPluginCohortRecovery(run.runId, options)?.cohort,
    warnings: () => updateRunWarningMessages(getUpdateRun(run.runId, options)?.steps ?? []),
    serve() {
      recordUpdateRunVerification(
        run.runId,
        {
          serviceRunning: true,
          versionMatch: true,
          runningVersion: to.version,
          ...(to.buildId ? { runningBuildId: to.buildId } : {}),
          readyz: true,
          settled: true,
        },
        options,
      );
    },
    recordRollback(settledPublications: 0 | 1) {
      // An earlier repair selected rollback, then refused before it finished.
      const pair = loadPluginCohortRecovery(run.runId, options)!;
      writePluginCohortRecovery(
        pair,
        { ...pair.cohort, disposition: "rollback", settledPublications },
        fence,
        options,
      );
    },
    async completeLater() {
      // The candidate's Doctor completes the obligation: a decision newer than the publication.
      await recordDeferredPluginMigrations({
        env: options.env,
        pending: [],
        settlements: [
          { pluginId: obligation.pluginId, status: "completed", reason: "candidate completed" },
        ],
      });
      await closeOpenClawStateDatabaseAsync();
      expect(row()).not.toEqual(beforeRow);
      return row();
    },
    async settle() {
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
    },
  };
}

function installedRoot(identity: Core, packageRecord?: true) {
  const root = path.join(dirs.make("cohort-settlement-install-"), "openclaw");
  installCore(root, identity);
  if (packageRecord) {
    // An activation anchor without its journal keeps the original owner's authority.
    fs.mkdirSync(resolvePackageActivationAnchor(root));
  }
  return root;
}

it.each([
  ["pending", candidate, undefined],
  ["refused rollback", candidate, 0],
  // Deploying a repair build replaces the candidate's build ID but not the original's absence.
  ["refused rollback under a later build", { version: candidate.version, buildId: "repair" }, 0],
] as const)(
  "settles a %s cohort forward once its candidate verified serving",
  async (_label, installed, refusedRollback) => {
    const f = await interruptedCohort({ root: installedRoot(installed) });
    f.serve();
    if (refusedRollback !== undefined) {
      f.recordRollback(refusedRollback);
    }
    const later = await f.completeLater();
    await f.settle();
    expect(f.cohort()).toBeUndefined();
    expect(await inspectPluginCohortRecoveryAdmission(f.options)).toBeUndefined();
    expect(f.row()).toEqual(later);
    expect(f.warnings()).toEqual([]);
  },
);

it.each([
  ["the original core is installed", { installed: original, served: true }],
  [
    "the original version has no readable build",
    { installed: { version: original.version, buildId: null }, served: true },
  ],
  ["the candidate never verified serving", { installed: candidate, served: false }],
  [
    "a package activation record remains",
    { installed: candidate, served: true, packageRecord: true },
  ],
  [
    "rollback already settled a publication",
    { installed: candidate, served: true, settledPublications: 1 },
  ],
] as const)("settles by rollback and keeps the later decision when %s", async (_label, shape) => {
  const packageRecord = "packageRecord" in shape ? shape.packageRecord : undefined;
  const f = await interruptedCohort({ root: installedRoot(shape.installed, packageRecord) });
  if (shape.served) {
    f.serve();
  }
  if ("settledPublications" in shape) {
    f.recordRollback(shape.settledPublications);
  }
  const later = await f.completeLater();
  await f.settle();
  expect(f.cohort()).toBeUndefined();
  expect(f.row()).toEqual(later);
  expect(f.warnings()).toEqual([expect.stringContaining(KEPT_OBLIGATION)]);
});

it.skipIf(process.platform === "win32").each(["completed", "unfinished"] as const)(
  "decides an npm cohort by its %s package activation",
  async (activationState) => {
    const lifetime = createPackageActivationLifetimeFixture();
    try {
      const { root: base } = lifetime.setup();
      let packageRoot: string;
      if (activationState === "completed") {
        const prepared = await lifetime.prepare();
        packageRoot = prepared.packageRoot;
        // The settled journal remains as a completion fact, not restoration authority.
        await settlePendingPackageActivation(packageRoot, () => {});
      } else {
        // The candidate is installed, but the journal still holds restoration custody.
        packageRoot = (await createInterruptedPackagePublication(base, "publication-complete"))
          .packageRoot;
      }
      const anchor = resolvePackageActivationAnchor(packageRoot);
      expect(fs.existsSync(resolvePackageActivationJournalPath(anchor))).toBe(true);
      const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
        .version as string;
      const f = await interruptedCohort({
        root: packageRoot,
        from: { version: `${version}-original`, buildId: null },
        to: { version, buildId: null },
      });
      f.serve();
      const later = await f.completeLater();
      await f.settle();
      expect(f.cohort()).toBeUndefined();
      expect(f.row()).toEqual(later);
      // A completed activation settles forward; an unfinished one rolls back.
      expect(f.warnings()).toEqual(
        activationState === "completed" ? [] : [expect.stringContaining(KEPT_OBLIGATION)],
      );
    } finally {
      await lifetime.cleanup();
    }
  },
);

it("continues a rollback that restored migrations before it was interrupted", async () => {
  const f = await interruptedCohort({ root: installedRoot(candidate), config: true });
  // Stop the first rollback after it restored migration rows, before any counted publication.
  vi.spyOn(configRecovery, "restorePluginCohortConfigPublication").mockRejectedValueOnce(
    new Error("interrupted before config restore"),
  );
  await expect(f.settle()).rejects.toThrow("interrupted before config restore");
  expect(f.cohort()).toMatchObject({ disposition: "rollback", settledPublications: 0 });
  expect(f.row()).toEqual(f.beforeRow);
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.afterConfig);

  // Rollback already reverted the obligation, so the verified candidate cannot commit over it.
  f.serve();
  await f.settle();
  expect(f.cohort()).toBeUndefined();
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(f.beforeConfig);
  expect(f.row()).toEqual(f.beforeRow);
});

it("completes a rollback that keeps a later config edit", async () => {
  const f = await interruptedCohort({ root: installedRoot(candidate), config: true });
  const edited = f.afterConfig.replace('"port": 1', '"port": 2');
  fs.writeFileSync(f.configPath, edited);
  await f.settle();
  expect(f.cohort()).toBeUndefined();
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(edited);
  expect(f.row()).toEqual(f.beforeRow);
  expect(f.warnings()).toEqual([expect.stringContaining("config file")]);
});

it("keeps rollback pending when the edited config is invalid", async () => {
  const f = await interruptedCohort({ root: installedRoot(candidate), config: true });
  // A later writer left config that no longer validates; that is not an edit to keep.
  const invalid = f.afterConfig.replace('"port": 1', '"port": "not-a-port"');
  fs.writeFileSync(f.configPath, invalid);
  await expect(f.settle()).rejects.toThrow("Configuration is invalid after update publication");
  expect(f.cohort()).toMatchObject({ disposition: "rollback", settledPublications: 0 });
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(invalid);
});

it("still reports a kept config edit after a later settlement step fails", async () => {
  const f = await interruptedCohort({ root: installedRoot(candidate), config: true });
  const edited = f.afterConfig.replace('"port": 1', '"port": 2');
  fs.writeFileSync(f.configPath, edited);
  // Settlement counts the kept config file, then stops before it finishes.
  vi.spyOn(recoveryStore, "deletePluginCohortRecovery").mockImplementationOnce(() => {
    throw new Error("interrupted after counting the config file");
  });
  await expect(f.settle()).rejects.toThrow("interrupted after counting the config file");
  expect(f.cohort()?.settledPublications).toBe(2);
  await f.settle();
  expect(f.cohort()).toBeUndefined();
  expect(fs.readFileSync(f.configPath, "utf8")).toBe(edited);
  expect(f.warnings()).toEqual([expect.stringContaining("config file")]);
});

it("settles a plugin cohort stored by released updaters, keeping later decisions", async () => {
  // Rows exactly as the shipped updater and refused repair left them; only paths and
  // the run identity differ. This change adds no field and reads them unchanged.
  const stateDir = dirs.make("cohort-settlement-stored-");
  const root = installedRoot(original);
  const options = { env: { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir, NODE_ENV: "test" } };
  const report = (pluginId: string) =>
    JSON.stringify({
      pluginId,
      reason:
        "Package convergence must wait until the updating parent releases its install records.",
      command: "openclaw update repair",
      requiresStateMigration: true,
    });
  const row = (pluginId: string, finishedAt: number | null) => ({
    startedAt: 1792078289392,
    finishedAt,
    status: finishedAt === null ? "pending" : "completed",
    reportJson: report(pluginId),
  });
  const pluginIds = ["discord", "whatsapp"];
  for (const pluginId of pluginIds) {
    await recordDeferredPluginMigrations({
      env: options.env,
      pending: [{ ...obligation, pluginId }],
    });
    // Each obligation was completed after the update published it.
    await recordDeferredPluginMigrations({
      env: options.env,
      pending: [],
      settlements: [{ pluginId, status: "completed", reason: "later Doctor" }],
    });
  }
  const { runId } = createUpdateRun({ trigger: "cli" }, options);
  const identity = (core: Core) => ({ root, nodePath: process.execPath, ...core });
  writeConfigMachineState(
    `update.recovery.${runId}`,
    {
      runId,
      transactionId: "530520b0-b38c-4afd-9de0-299c53948be0",
      revision: 0,
      claimId: "9228b442-7879-4dd0-a079-ed08ee0f1713",
      claimKind: "initial",
      handoff: null,
      source: { stateDir, configPath: path.join(stateDir, "openclaw.json") },
      from: identity(original),
      to: identity(candidate),
      createdAtMs: 1793834878779,
      updatedAtMs: 1793834878779,
      effects: [],
      restore: null,
      verification: null,
      primaryFailure: null,
    },
    options,
  );
  writeConfigMachineState(
    `update.pluginCohort.${runId}`,
    {
      runId,
      transactionId: "530520b0-b38c-4afd-9de0-299c53948be0",
      revision: 2,
      disposition: "rollback",
      installKey: root,
      priorArtifacts: [],
      artifacts: [],
      publications: [
        {
          kind: "plugin-migrations",
          rows: pluginIds.map((pluginId) => ({
            pluginId,
            before: row(pluginId, 1793831024586),
            after: row(pluginId, null),
          })),
        },
      ],
      settledPublications: 0,
    },
    options,
  );
  await closeOpenClawStateDatabaseAsync();
  const rows = () =>
    openOpenClawStateDatabase(options)
      .db.prepare("SELECT id, finished_at, status FROM migration_runs ORDER BY id")
      .all();
  const later = rows();
  const expected = await inspectPluginCohortRecoveryAdmission(options, runId);
  if (!expected) {
    throw new Error("Expected the stored plugin cohort to require repair");
  }
  await settleInterruptedUpdatePluginCohort({
    expected,
    root,
    options,
    assertCurrent: () => fence.assertCurrent(),
  });
  expect(loadPluginCohortRecovery(runId, options)).toBeUndefined();
  expect(await inspectPluginCohortRecoveryAdmission(options)).toBeUndefined();
  expect(rows()).toEqual(later);
  expect(updateRunWarningMessages(getUpdateRun(runId, options)?.steps ?? [])).toEqual([
    expect.stringMatching(/plugin discord .*plugin whatsapp /u),
  ]);
});
