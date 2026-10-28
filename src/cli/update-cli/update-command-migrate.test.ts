import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../../packages/terminal-core/src/note.js";
import * as databaseEngine from "../../commands/doctor-database-engine.js";
import * as doctorUi from "../../commands/doctor-ui.js";
import * as doctor from "../../flows/doctor-health.js";
import * as jsonFiles from "../../infra/json-files.js";
import { recordUpdateDoctorDeferredInspectionChecks } from "../../infra/update-doctor-result.js";
import * as updateHistory from "../../infra/update-run-ledger.js";
import { listUpdateRuns } from "../../infra/update-run-reader.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as readiness from "../daemon-cli/restart-health-probe.js";
import * as sharedUpdate from "./shared.js";
import {
  updateFinishCommand,
  updateMigrateCommand,
  updateRestoreCommand,
} from "./update-command-migrate.js";

afterEach(() => vi.restoreAllMocks());

const readText = (file: string) => fs.readFile(file, "utf8");

it("migrates the Claws preference through candidate Doctor with a rollback original", async () => {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SUPERVISOR_MODE: "external" },
    },
    async (state) => {
      vi.spyOn(doctorUi, "maybeRepairUiProtocolFreshness").mockResolvedValue();
      await state.writeConfig({
        plugins: { enabled: false },
        gateway: {
          mode: "local",
          auth: { mode: "none" },
          controlUi: {
            enabled: false,
            experimental: { customPlugins: true, chatBubbles: true, claws: true },
          },
        },
      });
      const original = await readText(state.configPath);
      const backupRoot = state.path("templates-recovery", "native");
      const engineInspection = vi.spyOn(databaseEngine, "noteDatabaseEngines");
      const progress = vi.spyOn(process.stderr, "write");
      await updateMigrateCommand(backupRoot);
      expect(
        progress.mock.calls
          .map(([line]) => String(line))
          .filter((line) => /^Doctor: Update (migration [\w ]+|schema admission)\n$/.test(line)),
      ).toEqual([
        "Doctor: Update migration config admission\n",
        "Doctor: Update migration schema preflight\n",
        "Doctor: Update migration database backup\n",
        "Doctor: Update schema admission\n",
        "Doctor: Update migration schema verification\n",
      ]);
      const receipt = JSON.parse(await readText(`${backupRoot}.receipt.json`));
      expect(receipt.status).toBe("migrated");
      expect(engineInspection).not.toHaveBeenCalled();
      expect(receipt.deferredInspectionCheckIds).toContain("core/doctor/database-engine");
      expect(receipt.configFiles).toContainEqual(
        expect.objectContaining({ path: state.configPath, raw: original }),
      );
      expect(JSON.parse(await readText(state.configPath)).gateway.controlUi.experimental).toEqual({
        customPlugins: true,
        chatBubbles: true,
        templates: true,
      });
    },
  );
});

it("migrates retired heartbeat config with its backed-up state only once", async () => {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SUPERVISOR_MODE: "external" },
    },
    async (state) => {
      vi.spyOn(doctorUi, "maybeRepairUiProtocolFreshness").mockResolvedValue();
      await state.writeConfig({
        agents: {
          defaults: {
            heartbeat: {
              every: "17m",
              target: "none",
              prompt: "Check the synthetic checklist.",
              activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
            },
          },
          entries: { main: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
        gateway: { mode: "local", controlUi: { enabled: false }, auth: { mode: "none" } },
      });
      const original = await readText(state.configPath);
      const databasePath = openOpenClawStateDatabase().path;
      await closeOpenClawStateDatabaseAsync();
      {
        using db = new DatabaseSync(databasePath);
        // Schema 30 changed the scheduler contract, not the schema 29 table layout.
        db.exec(`
          PRAGMA user_version=29;
          UPDATE schema_meta SET schema_version=29 WHERE meta_key='primary';
          UPDATE config_machine_state SET value_json='29'
            WHERE state_key='state.schema.contentVersion';
        `);
      }
      const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
      const backupRoot = state.path("heartbeat-recovery", "native");
      await updateMigrateCommand(backupRoot);
      const receipt = JSON.parse(await readText(`${backupRoot}.receipt.json`));
      expect(receipt.status).toBe("migrated");
      expect(receipt.configFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: state.configPath, raw: original }),
        ]),
      );
      const saved = JSON.parse(await readText(state.configPath));
      expect(saved.agents.defaults).not.toHaveProperty("heartbeat");
      const readJobs = () => {
        using db = new DatabaseSync(databasePath, { readOnly: true });
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        return db
          .prepare("SELECT job_json FROM cron_jobs ORDER BY job_id")
          .all()
          .map((row) => JSON.parse(String(row.job_json)));
      };
      const jobs = readJobs();
      expect(jobs).toEqual([
        expect.objectContaining({
          agentId: "main",
          enabled: true,
          schedule: expect.objectContaining({ kind: "every", everyMs: 1_020_000 }),
          activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
          payload: expect.objectContaining({
            kind: "agentTurn",
            message: "Check the synthetic checklist.",
          }),
          delivery: { mode: "none" },
        }),
      ]);
      await updateMigrateCommand(state.path("second-recovery", "native"));
      expect(readJobs()).toEqual(jobs);
      expect(
        note.mock.calls.filter(([, title]) => title === "Heartbeat delivery changed"),
      ).toHaveLength(1);
      await updateRestoreCommand(backupRoot);
      expect(await readText(state.configPath)).toBe(original);
      using restored = new DatabaseSync(databasePath, { readOnly: true });
      expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(29);
      expect(restored.prepare("SELECT count(*) AS count FROM cron_jobs").get()?.count).toBe(0);
    },
  );
});

it.each([
  { heartbeat: { every: "not-an-interval" } },
  { heartbeat: { every: "30m" }, unknownSetting: true },
])("refuses invalid heartbeat migration input before backup: %j", async (defaults) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig({ agents: { defaults } });
    const original = await readText(state.configPath);
    const backupRoot = state.path("invalid-recovery", "native");
    await expect(updateMigrateCommand(backupRoot)).rejects.toMatchObject({
      reason: "invalid-config",
    });
    expect(await readText(state.configPath)).toBe(original);
    await expect(fs.stat(`${backupRoot}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["restored", "failed", "finished", "retried", "absent", "symlink", "unchanged"] as const)(
  "settles native migration recovery as %s",
  async (outcome) => {
    const fail = outcome === "failed";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = openOpenClawStateDatabase({ env: state.env });
      const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const agent = openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
      agent.db.exec(
        "CREATE TABLE update_witness(value TEXT); INSERT INTO update_witness VALUES ('before');",
      );
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      const included = path.join(state.stateDir, "settings.json");
      const original = '{ "$include": "settings.json" }\n';
      const originalIncluded = '{ "gateway": { "mode": "local" } }\n';
      await fs.writeFile(state.configPath, original);
      await fs.writeFile(included, originalIncluded);
      const includeTarget = path.join(state.stateDir, "settings-target.json");
      if (outcome === "symlink") {
        await fs.rename(included, includeTarget);
        await fs.symlink(includeTarget, included);
      }
      const originalIncludeIdentity = await fs.stat(included);
      if (outcome === "absent") {
        await fs.rm(state.configPath);
      }
      let backupRoot = state.path("update-recovery", "native");
      if (outcome === "restored") {
        const alias = state.path("recovery-link");
        await fs.mkdir(path.dirname(backupRoot));
        await fs.symlink(path.dirname(backupRoot), alias, "junction");
        backupRoot = path.join(alias, "native");
      }
      const receiptPath = `${backupRoot}.receipt.json`;
      const readReceipt = async () => JSON.parse(await readText(receiptPath));
      const restore = () => updateRestoreCommand(backupRoot);
      const runDoctor = vi
        .spyOn(doctor, "runDoctorHealthFlow")
        .mockImplementation(async (_runtime, _options, _authority, preflight) => {
          if (outcome === "finished") {
            expect(
              recordUpdateDoctorDeferredInspectionChecks(["core/doctor/database-engine"]),
            ).toEqual(["core/doctor/database-engine"]);
          }
          const receipt = await readReceipt();
          expect(receipt.status).toBe("backed-up");
          const [agentIdentity, sharedIdentity] = await Promise.all([
            fs.stat(agentPath, { bigint: true }),
            fs.stat(shared.path, { bigint: true }),
          ]);
          for (const [file, identity, owner] of [
            [agentPath, agentIdentity, { role: "agent", agentId: "main" }],
            [shared.path, sharedIdentity, { role: "global" }],
          ] as const) {
            expect(preflight?.verifiedSnapshots).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  sourcePath: file,
                  ...owner,
                  dev: identity.dev,
                  ino: identity.ino,
                }),
              ]),
            );
            expect(receipt.databaseIdentities[file]).toEqual({
              dev: Number(identity.dev),
              ino: Number(identity.ino),
            });
          }
          using database = new DatabaseSync(agentPath);
          database.exec("UPDATE update_witness SET value='candidate';");
          await fs.writeFile(state.configPath, '{"gateway":{"mode":"local"}}\n');
          if (outcome !== "absent" && outcome !== "unchanged") {
            await fs.writeFile(included, "{}\n");
          }
          if (fail) {
            throw new Error("synthetic Doctor failure");
          }
        });
      if (fail) {
        await expect(updateMigrateCommand(backupRoot)).rejects.toThrow("synthetic Doctor failure");
      } else {
        await updateMigrateCommand(backupRoot);
      }
      expect(runDoctor).toHaveBeenCalledOnce();
      expect((await readReceipt()).status).toBe(fail ? "failed" : "migrated");
      if (outcome === "finished") {
        // A receipt from an earlier candidate has no start time: it retires unrecorded.
        const { startedAtMs, deferredInspectionCheckIds, ...legacy } = await readReceipt();
        await fs.writeFile(receiptPath, JSON.stringify(legacy));
        await updateFinishCommand(backupRoot);
        const receipt = await readReceipt();
        expect(receipt).toMatchObject({ status: "finished", configFiles: [] });
        await expect(fs.stat(receipt.backup.directory)).rejects.toMatchObject({ code: "ENOENT" });
        expect(listUpdateRuns({}, { env: state.env })).toEqual([]);
        // With it, the run starts at migration, and a retried finish keeps the one record.
        await fs.writeFile(
          receiptPath,
          JSON.stringify({ ...receipt, startedAtMs, deferredInspectionCheckIds }),
        );
        const candidate = state.path("candidate");
        await fs.mkdir(path.join(candidate, "dist"), { recursive: true });
        vi.spyOn(sharedUpdate, "resolveUpdateRoot").mockResolvedValue(candidate);
        const invocations = path.join(candidate, "lint-invocations.txt");
        const lint = (checksRun: number) =>
          fs.writeFile(
            path.join(candidate, "dist/index.js"),
            `process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(invocations)}, "called\\n"); process.stdout.write(JSON.stringify({ ok: false, checksRun: ${checksRun}, findings: [{checkId: "core/doctor/database-engine", severity: "warning", message: "Synthetic engine warning."}] })); process.exitCode = 1;`,
          );
        await lint(0);
        const ready = vi
          .spyOn(readiness, "waitForGatewayHttpReadiness")
          .mockResolvedValue({ healthz: 200, readyz: 200, coreReady: true })
          .mockImplementationOnce(async () => {
            expect(listUpdateRuns({}, { env: state.env })[0]?.steps).toContainEqual(
              expect.objectContaining({
                step: "warning:post-activation doctor inspections",
                detail: expect.stringContaining("are pending"),
              }),
            );
            return { healthz: null, readyz: null, coreReady: false };
          });
        await updateFinishCommand(backupRoot);
        expect((await readReceipt()).deferredInspectionCheckIds).toEqual(
          deferredInspectionCheckIds,
        );
        expect(ready).toHaveBeenCalledWith(
          expect.objectContaining({ attempts: 1, requireChannelHealth: false }),
        );
        await expect(fs.stat(invocations)).rejects.toMatchObject({ code: "ENOENT" });
        await updateFinishCommand(backupRoot);
        expect(await readText(invocations)).toBe("called\n");
        expect((await readReceipt()).deferredInspectionCheckIds).toEqual(
          deferredInspectionCheckIds,
        );
        await lint(1);
        const recordDiagnostic = updateHistory.recordUpdateRunDiagnostic;
        const diagnostic = vi
          .spyOn(updateHistory, "recordUpdateRunDiagnostic")
          .mockImplementationOnce(recordDiagnostic)
          .mockImplementationOnce(() => {
            throw new Error("synthetic history contention");
          });
        await updateFinishCommand(backupRoot);
        expect((await readReceipt()).deferredInspectionCheckIds).toEqual(
          deferredInspectionCheckIds,
        );
        diagnostic.mockRestore();
        await updateFinishCommand(backupRoot);
        expect((await readReceipt()).deferredInspectionCheckIds).toEqual([]);
        const completedInvocations = await readText(invocations);
        await updateFinishCommand(backupRoot);
        expect(await readText(invocations)).toBe(completedInvocations);
        const recorded = listUpdateRuns({}, { env: state.env })[0]!;
        expect(recorded.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:post-activation doctor inspections",
            detail: "core/doctor/database-engine: Synthetic engine warning.",
          }),
        );
        expect(
          recorded.steps.find(
            (step) => step.step === "finalize:doctor-lint:post-activation doctor inspections",
          )?.detail,
        ).toContain('"warning":1');
        expect(
          recorded.steps
            .filter((step) => step.step.startsWith("warning:"))
            .map((step) => step.detail)
            .join("\n"),
        ).not.toContain("did not complete");
        expect(listUpdateRuns({}, { env: state.env })).toEqual([
          expect.objectContaining({
            runId: receipt.runId,
            createdAtMs: startedAtMs,
            status: "succeeded",
          }),
        ]);
        await expect(restore()).rejects.toThrow("rollback backup has been retired");
        return;
      }
      if (outcome === "retried") {
        const write = jsonFiles.writeTextAtomic;
        let interrupted = false;
        vi.spyOn(jsonFiles, "writeTextAtomic").mockImplementation(async (...args) => {
          if (args[0] === included && !interrupted) {
            interrupted = true;
            throw new Error("synthetic include restoration failure");
          }
          return write(...args);
        });
        await expect(restore()).rejects.toThrow("synthetic include restoration failure");
        expect((await readReceipt()).status).toBe("restoring-config");
        const later = '{"gateway":{"mode":"local","port":19999}}\n';
        await fs.writeFile(state.configPath, later);
        await expect(restore()).rejects.toThrow("newer bytes were preserved");
        expect(await readText(state.configPath)).toBe(later);
        await fs.writeFile(state.configPath, original);
      }
      await restore();
      const receipt = await readReceipt();
      expect(receipt.status).toBe("restored");
      if (outcome === "absent") {
        await expect(fs.stat(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(receipt.configIdentity).toBeNull();
      } else {
        expect(await readText(state.configPath)).toBe(original);
        expect(receipt.configIdentity.ino).toBe((await fs.stat(state.configPath)).ino);
      }
      expect(await readText(included)).toBe(originalIncluded);
      if (outcome === "symlink") {
        expect((await fs.lstat(included)).isSymbolicLink()).toBe(true);
        expect(await readText(includeTarget)).toBe(originalIncluded);
      }
      if (outcome === "unchanged") {
        expect((await fs.stat(included)).ino).toBe(originalIncludeIdentity.ino);
      }
      const displaced = (
        outcome === "absent" || outcome === "unchanged"
          ? [state.configPath]
          : [state.configPath, outcome === "symlink" ? includeTarget : included]
      ).map((file) => `${file}.migrated-${receipt.runId}`);
      expect(receipt.displacedConfigFiles).toEqual(displaced);
      expect(await readText(displaced[0]!)).toBe('{"gateway":{"mode":"local"}}\n');
      if (outcome !== "absent" && outcome !== "unchanged") {
        expect(await readText(displaced[1]!)).toBe("{}\n");
      }
      using restored = new DatabaseSync(agentPath, { readOnly: true });
      expect(restored.prepare("SELECT value FROM update_witness").get()?.value).toBe("before");
      expect(receipt.databaseIdentities[agentPath].ino).toBe((await fs.stat(agentPath)).ino);
    });
  },
);

it("refuses a future database before capture or Doctor mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const agent = openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
    agent.db.exec("PRAGMA user_version=999;");
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    const doctorRun = vi.spyOn(doctor, "runDoctorHealthFlow");
    const backupRoot = state.path("future-recovery");
    await expect(updateMigrateCommand(backupRoot)).rejects.toThrow("schema 999");
    expect(doctorRun).not.toHaveBeenCalled();
    await expect(fs.stat(`${backupRoot}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
