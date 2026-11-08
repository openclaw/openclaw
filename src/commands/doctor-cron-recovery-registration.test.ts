import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { saveCronJobsStore } from "../cron/store.js";
import { resolveSessionSqliteMigrationRunsDir } from "../infra/session-sqlite-migration-manifest.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "./doctor-config-flow.test-support.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
} from "./doctor/cron/legacy-repair.js";
import { repairLegacyCronJobOwnersForDoctor } from "./doctor/cron/store-repair.js";

afterEach(() => vi.restoreAllMocks());

const backupPaths = (databasePath: string) =>
  fs
    .readdirSync(path.dirname(databasePath))
    .filter((name) => name.endsWith(".bak"))
    .map((name) => path.join(path.dirname(databasePath), name));

it.each(["owner", "legacy"] as const)(
  "registers the real %s cron repair original through completion and later-update eligibility",
  async (entry) => {
    await withOpenClawTestState({ label: "cron-recovery-registration" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      const storePath = state.statePath("cron", "jobs.json");
      const job = makeCronJob({ id: "repair-me", enabled: false });
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const { db, path: databasePath } = openOpenClawStateDatabase();
      if (entry === "legacy") {
        db.prepare(
          "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', ' NoNe ')",
        ).run();
      }
      const before = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id);
      const inventory = () => collectRecoveryInventory({ cfg, env: state.env });
      await withDoctorConfigMaintenance(async () => {
        const maintenance = getOpenClawDatabaseMaintenanceScope()!;
        const assertCurrent = () => maintenance.assertDatabaseAccess(databasePath);
        const repair = async () => {
          if (entry === "owner") {
            return repairLegacyCronJobOwnersForDoctor(
              { env: state.env },
              { assertCurrent, assertOwnedInTransaction: assertCurrent },
              storePath,
              "main",
            );
          }
          const inspected = await loadLegacyCronRepairState({
            cfg,
            storePath,
            env: state.env,
            readOnly: true,
          });
          expect(inspected).not.toBeNull();
          return applyLegacyCronStoreRepair({ cfg, state: inspected! });
        };
        await repair();
        const backups = backupPaths(databasePath);
        expect(backups).toHaveLength(1);
        expect(
          db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id),
        ).not.toEqual(before);
        expect(inventory().report.artifacts).toContainEqual(
          expect.objectContaining({
            path: backups[0],
            outcome: "protected",
            reason: "incomplete-recovery-operation",
          }),
        );
        const refs = inventory().references.get(backups[0]!)!;
        expect(refs).toHaveLength(1);
        expect(refs[0]!.move.artifact?.classification).toBe("repair-original");
        expect(refs[0]!.run.manifest.completedAt).toBeUndefined();
        await repair();
        expect(backupPaths(databasePath)).toEqual(backups);
        completeDoctorMigrationBackups(state.env, [databasePath]);
        expect(inventory().report.artifacts).toContainEqual(
          expect.objectContaining({
            path: backups[0],
            outcome: "protected",
            reason: "awaiting-later-completed-update",
          }),
        );
        const completedAt = inventory().references.get(backups[0]!)![0]!.run.manifest.completedAt!;
        using clock = vi.spyOn(Date, "now");
        clock.mockReturnValue(Date.parse(completedAt) + 1_000);
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
        expect(inventory().report.artifacts).toContainEqual(
          expect.objectContaining({
            path: backups[0],
            outcome: "candidate",
            reason: "producer-verified-original",
          }),
        );
        expect(fs.existsSync(backups[0]!)).toBe(true);
      });
    });
  },
);

it("reuses an interrupted plan's original but captures a different planned effect", async () => {
  await withOpenClawTestState({ label: "cron-recovery-retry" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [makeCronJob({ id: "ownerless" })] });
    const { path: databasePath } = openOpenClawStateDatabase();
    await withDoctorConfigMaintenance(async () => {
      const assertCurrent = () =>
        getOpenClawDatabaseMaintenanceScope()!.assertDatabaseAccess(databasePath);
      const interrupted = {
        assertCurrent,
        assertOwnedInTransaction() {
          throw new Error("repair interrupted before write");
        },
      };
      const attempt = (owner: string) =>
        repairLegacyCronJobOwnersForDoctor({ env: state.env }, interrupted, storePath, owner);
      await expect(attempt("main")).rejects.toThrow("repair interrupted before write");
      const first = backupPaths(databasePath);
      expect(first).toHaveLength(1);
      const original = fs.readFileSync(first[0]!);
      await expect(attempt("main")).rejects.toThrow("repair interrupted before write");
      expect(backupPaths(databasePath)).toEqual(first);
      await expect(attempt("research")).rejects.toThrow("repair interrupted before write");
      expect(backupPaths(databasePath)).toHaveLength(2);
      const result = await repairLegacyCronJobOwnersForDoctor(
        { env: state.env },
        { assertCurrent, assertOwnedInTransaction: assertCurrent },
        storePath,
        "main",
      );
      expect(result).toMatchObject({ changed: 1, backupPath: first[0] });
      expect(backupPaths(databasePath)).toHaveLength(2);
      expect(fs.readFileSync(first[0]!)).toEqual(original);
    });
  });
});

it("returns registration failures while retaining the verified original and committed repair", async () => {
  await withOpenClawTestState({ label: "cron-recovery-warning" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [makeCronJob({ id: "ownerless" })] });
    fs.writeFileSync(
      resolveSessionSqliteMigrationRunsDir(state.env),
      "unavailable manifest directory",
    );
    const { db, path: databasePath } = openOpenClawStateDatabase();
    await withDoctorConfigMaintenance(async () => {
      const assertCurrent = () =>
        getOpenClawDatabaseMaintenanceScope()!.assertDatabaseAccess(databasePath);
      const result = await repairLegacyCronJobOwnersForDoctor(
        { env: state.env },
        { assertCurrent, assertOwnedInTransaction: assertCurrent },
        storePath,
        "main",
      );
      expect(result.changed).toBe(1);
      expect(result.warnings).toEqual([expect.stringContaining("cleanup registration failed")]);
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      expect(db.prepare("SELECT agent_id FROM cron_jobs WHERE job_id = 'ownerless'").get()).toEqual(
        {
          agent_id: "main",
        },
      );
    });
  });
});

it("discovers only historical shared cron originals without granting completion or retirement", async () => {
  await withOpenClawTestState({ label: "cron-recovery-unmanifested" }, async (state) => {
    const name =
      "openclaw.sqlite.doctor-cron-1790000000000-12345678-1234-4123-8123-123456789abc.bak";
    const original = state.statePath("state", name);
    const unrelated = [
      state.statePath("state", name.replace("1790000000000", "invalid")),
      state.statePath("state", name.replace("4123", "1123")),
      state.statePath("state", `${name}.copy`),
      path.join(state.agentDir(), name),
    ];
    for (const file of [original, ...unrelated]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "retained original");
    }
    const inventory = collectRecoveryInventory({ cfg: {}, env: state.env });
    expect(inventory.report.artifacts).toEqual([
      expect.objectContaining({
        path: original,
        runs: [],
        outcome: "protected",
        reason: "unmanifested-recovery-original",
      }),
    ]);
    expect(inventory.references.size).toBe(0);
    for (const file of [original, ...unrelated]) {
      expect(fs.readFileSync(file, "utf8")).toBe("retained original");
    }
  });
});
