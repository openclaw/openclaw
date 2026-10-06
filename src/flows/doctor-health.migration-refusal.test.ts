import "./doctor-health.test-support.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import * as nocow from "../commands/doctor-sqlite-nocow.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
} from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  DoctorMaintenanceRefusalError,
  UpdateDoctorError,
} from "../infra/update-doctor-result.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { readConfiguredParsedLogTail } from "../logging/log-tail.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { ExitError } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  claimOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeDoctorGatewayConfig } from "./doctor-health-contribution-runners.gateway.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
const { mocks } = await import("./doctor-health.test-support.js");

const snapshotProcesses = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  snapshotProcesses.execFile.mockImplementation(actual.execFile);
  Object.defineProperty(
    snapshotProcesses.execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile: snapshotProcesses.execFile };
});

const maintenance = vi.hoisted(() => ({
  signal: new AbortController().signal,
  serviceUpdateVerdict: undefined,
  warnings: [],
  failureFacts: [],
  databaseWrites: undefined,
  run: <T>(operation: () => T): T => operation(),
  finish: vi.fn(),
  releaseState: vi.fn(),
  repairSqliteNoCow: vi.fn(),
  enableSqliteReclamation: vi.fn(),
  cleanupRetainedRuntimes: vi.fn(),
  release: vi.fn(),
}));
const resultWriter = await vi.importActual<typeof import("../infra/update-doctor-result.js")>(
  "../infra/update-doctor-result.js",
);
beforeEach(() => {
  mocks.writeUpdatePostInstallDoctorResult.mockImplementation(
    resultWriter.writeUpdatePostInstallDoctorResult,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Doctor refused-migration maintenance outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maintenance.enableSqliteReclamation.mockReset();
    vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(maintenance);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
  });

  it.each([
    { fix: false, updating: undefined, request: "1", repair: false, conversion: false },
    { fix: false, updating: "1", request: "1", repair: false, conversion: false },
    { fix: true, updating: undefined, request: undefined, repair: true, conversion: false },
    { fix: true, updating: "0", request: "0", repair: true, conversion: false },
    { fix: true, updating: "1", request: undefined, repair: false, conversion: true },
    { fix: true, updating: "true", request: "0", repair: false, conversion: true },
    { fix: true, updating: "1", request: "1", repair: true, conversion: true },
  ])(
    "gates SQLite repairs after checks and before restoration (fix=$fix, update=$updating, request=$request)",
    async ({ fix, updating, request, repair, conversion }) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", updating);
      vi.stubEnv("OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR", request);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const events: string[] = [];
      const advisory =
        "SQLite store on btrfs without NOCOW: /synthetic/store.sqlite. Run openclaw doctor --fix to rewrite it while the Gateway is stopped.";
      vi.spyOn(nocow, "inspectDoctorSqliteNoCow").mockReturnValue({
        paths: ["/synthetic/store.sqlite"],
        notes: [advisory],
      });
      mocks.runContributions.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        events.push("checks completed");
      });
      maintenance.repairSqliteNoCow.mockReset().mockImplementationOnce(async () => {
        events.push("repair");
      });
      maintenance.enableSqliteReclamation.mockImplementationOnce(async () => {
        events.push("conversion");
      });
      maintenance.cleanupRetainedRuntimes.mockReset().mockImplementationOnce(async () => {
        events.push("cleanup");
      });
      maintenance.finish.mockImplementationOnce(async () => {
        events.push("restoration");
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const work = runDoctorHealthFlow(runtime, { repair: fix, nonInteractive: true });
      await entered.promise;
      expect(maintenance.repairSqliteNoCow).not.toHaveBeenCalled();
      expect(maintenance.enableSqliteReclamation).not.toHaveBeenCalled();
      proceed.resolve();
      await work;
      expect(events).toEqual([
        "checks completed",
        ...(repair ? ["repair"] : []),
        ...(conversion ? ["conversion"] : []),
        ...(fix ? ["cleanup"] : []),
        "restoration",
      ]);
      if (conversion) {
        expect(maintenance.enableSqliteReclamation).toHaveBeenCalledOnce();
      } else {
        expect(maintenance.enableSqliteReclamation).not.toHaveBeenCalled();
      }
      if (repair) {
        expect(maintenance.repairSqliteNoCow).toHaveBeenCalledExactlyOnceWith([
          "/synthetic/store.sqlite",
        ]);
      } else {
        expect(maintenance.repairSqliteNoCow).not.toHaveBeenCalled();
      }
      expect(runtime.log).toHaveBeenCalledWith(advisory);
      const deferred =
        "SQLite NOCOW repair deferred: the managed updater did not request the store rewrite in this run.";
      if (fix && !repair) {
        expect(runtime.log).toHaveBeenCalledWith(deferred);
      } else {
        expect(runtime.log).not.toHaveBeenCalledWith(deferred);
      }
    },
  );

  it.each(["diagnostic", "runtime exit"])(
    "settles %s failure before forwarding database write proof",
    async (kind) => {
      const resultPath = createUpdatePostInstallDoctorResultPath();
      await withOpenClawTestState(
        {
          scenario: "minimal",
          env: { OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath },
        },
        async (state) => {
          await state.writeConfig({ gateway: { mode: "local" } });
          const databaseGenerations = { [state.statePath("state/openclaw.sqlite")]: null };
          const databaseWrites = { unchanged: false, generations: databaseGenerations };
          let released = false;
          const release = vi.fn(async () => {
            released = true;
          });
          vi.mocked(doctorMaintenance.beginDoctorMaintenance).mockResolvedValueOnce({
            ...maintenance,
            get databaseWrites() {
              return released ? databaseWrites : undefined;
            },
            release,
          });
          const failure =
            kind === "runtime exit"
              ? new ExitError(130)
              : new Error("injected post-migration Doctor failure");
          mocks.runContributions.mockImplementationOnce(async (ctx) => {
            if (kind === "runtime exit") {
              ctx.runtime.exit(130);
            } else {
              throw failure;
            }
          });
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const work = runDoctorHealthFlow(
            runtime,
            { repair: true, nonInteractive: true },
            { inputHash: hashConfigRaw(null), assertCurrent() {}, databaseGenerations },
          );
          if (kind === "runtime exit") {
            await expect(work).rejects.toEqual(failure);
          } else {
            await expect(work).rejects.toBe(failure);
          }
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(undefined, undefined, failure);
          expect(release).toHaveBeenCalledOnce();
          expect(mocks.outro).not.toHaveBeenCalled();
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Check the reported service state"),
          );
          expect(doctorMaintenance.beginDoctorMaintenance).toHaveBeenCalledWith(
            expect.objectContaining({ databaseGenerations }),
          );
          await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toMatchObject({
            status: "error",
            databaseWrites,
          });
        },
      );
    },
  );

  it.each(["success", "validation", "conflict", "missing-receipt"] as const)(
    "uses the latest receipt for maintenance-time token recovery (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { gateway: { mode: "local" as const }, plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const planned = await readConfigFileSnapshot();
        mocks.config.mockReturnValue(cfg);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        mocks.runContributions.mockImplementationOnce(async (ctx) => {
          // The config-flow fixture skips planning; supply the revision observed before repair.
          ctx.configResult.confirmedConfigSource = {
            path: planned.path,
            hash: planned.hash ?? hashConfigRaw(planned.raw),
          };
          await writeDoctorGatewayConfig(ctx, {
            ...ctx.cfg,
            gateway: { ...ctx.cfg.gateway, port: 19091 },
          });
          const first = await readConfigFileSnapshot();
          expect(ctx.configResult.confirmedConfigSource).toEqual({
            path: first.path,
            hash: first.hash,
          });
          expect(first.hash).not.toBe(planned.hash);
          maintenance.finish.mockImplementationOnce(async (_cfg, writeConfig) => {
            expect(writeConfig).toBeTypeOf("function");
            if (outcome === "conflict") {
              fs.appendFileSync(state.configPath, "\n// operator-only raw drift\n");
            } else if (outcome === "missing-receipt") {
              ctx.configResult.confirmedConfigSource = { path: first.path, hash: null };
            }
            const previous = ctx.cfg;
            const baseline = ctx.cfgForPersistence;
            const receipt = ctx.configResult.confirmedConfigSource;
            const retained = [state.configPath, state.configPath + ".bak"].map((path) =>
              fs.readFileSync(path),
            );
            const candidate = {
              ...ctx.cfg,
              gateway: {
                ...ctx.cfg.gateway,
                auth: { mode: "token" as const, token: "maintenance-recovered-token" },
                ...(outcome === "validation" ? { port: 0 } : {}),
              },
            };
            if (outcome !== "success") {
              await expect(writeConfig(candidate)).rejects.toThrow("did not persist");
              expect(ctx.configWriteRefusal).toBe(
                outcome === "validation" ? "validation" : "config-conflict",
              );
              expect(ctx.cfg).toBe(previous);
              expect(ctx.cfgForPersistence).toBe(baseline);
              expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
              expect(
                [state.configPath, state.configPath + ".bak"].map((path) => fs.readFileSync(path)),
              ).toEqual(retained);
              expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
            } else {
              const committed = await writeConfig(candidate);
              expect(committed).toEqual(ctx.cfg);
              expect(ctx.cfgForPersistence.gateway?.auth?.token).toBe(
                "maintenance-recovered-token",
              );
              const saved = await readConfigFileSnapshot();
              expect(ctx.configResult.confirmedConfigSource).toEqual({
                path: saved.path,
                hash: saved.hash,
              });
              expect(saved.hash).not.toBe(first.hash);
              expect(saved.sourceConfig.gateway?.port).toBe(19091);
            }
          });
        });
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(maintenance.finish).toHaveBeenCalledOnce();
        const persisted = await readConfigFileSnapshot();
        expect(persisted.sourceConfig.gateway?.auth?.token).toBe(
          outcome === "success" ? "maintenance-recovered-token" : undefined,
        );
        expect(persisted.sourceConfig.gateway?.port).toBe(19091);
        if (outcome !== "success") {
          expect(runtime.exit).toHaveBeenCalledWith(1);
        } else {
          expect(runtime.exit).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("retains migration recovery and explains why source rollback cannot undo repaired state", async () => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: buildUpdateDoctorEnv({
          allowGatewayServiceRepair: true,
          allowGatewayActivation: false,
        }),
      },
      async (state) => {
        const root = state.path("checkout");
        fs.mkdirSync(root);
        execFileSync("git", ["init", root], { stdio: "ignore" });
        mocks.packageRoot.mockReturnValue(root);
        const failure = new DoctorStateMigrationRefusalError([
          {
            id: "agent-ownership",
            phase: "shared",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "not-applicable",
            outcome: "refused",
            changes: [],
            warnings: ["Resolve the reported ownership mismatch before retrying."],
            refusal: {
              code: "agent-database-ownership-mismatch",
              message: "Resolve the reported ownership mismatch before retrying.",
            },
          },
        ]);
        const originalMessage = failure.message;
        mocks.runContributions.mockImplementationOnce(async () => {
          await state.writeConfig({ gateway: { mode: "local" } });
          throw failure;
        });
        setLoggerOverride({
          level: "warn",
          consoleLevel: "silent",
          file: state.path("warnings.log"),
        });
        try {
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          await expect(
            runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
          ).rejects.toBe(failure);
          expect(failure.message.startsWith(originalMessage)).toBe(true);
          expect(failure.message).toContain(
            "Checking out the previous source is not enough: state repairs have already run.",
          );
          expect(failure.message).toContain("Follow the migration recovery instructions above");
          expect(failure.message).not.toContain("git -C");
          expect(failure.message).not.toContain("pnpm install");
          expect(failure.message).not.toContain("openclaw gateway start");
          expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toEqual({
            gateway: { mode: "local" },
          });
          expect(maintenance.release).toHaveBeenCalledOnce();
          expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(undefined, undefined, failure);
          expect(mocks.outro).not.toHaveBeenCalled();
          expect(runtime.error).not.toHaveBeenCalled();
          await flushLogger();
          const tail = await readConfiguredParsedLogTail();
          expect(tail.lines.map((line) => line.message).join("\n")).toContain(failure.message);
        } finally {
          await flushLogger();
          setLoggerOverride(null);
          resetLogger();
        }
      },
    );
  });
});

describe("Doctor maintenance admission", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["explicit", "unreadable"] as const)(
    "serializes unsafe maintenance refusal from the %s owner",
    async (kind) => {
      const resultPath = createUpdatePostInstallDoctorResultPath();
      const env = {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath,
      };
      await withOpenClawTestState({ scenario: "minimal", env }, async (state) => {
        const refusal = {
          kind: "data-at-risk" as const,
          reason:
            kind === "explicit" ? ("incomplete-migration" as const) : ("unreadable-state" as const),
        };
        const error =
          kind === "explicit"
            ? new DoctorMaintenanceRefusalError("An admitted migration is incomplete.", refusal)
            : new DoctorUnreadableStateDatabaseError(
                state.statePath("state/openclaw.sqlite"),
                "malformed schema",
              );
        mocks.packageRoot.mockReturnValue(undefined);
        mocks.runContributions.mockClear();
        vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockRejectedValueOnce(error);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const failure = await runDoctorHealthFlow(
          runtime,
          { repair: true, nonInteractive: true },
          undefined,
          { incompatible: [], indeterminate: [] },
        ).catch((cause: unknown) => cause);
        const result = await consumeUpdatePostInstallDoctorResult(resultPath);
        expect(failure).toBe(error);
        expect(result).toMatchObject({
          status: "error",
          configHash: "unchanged",
          maintenanceRefusal: refusal,
        });
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );

  it.each(
    (["gateway", "schema", "agent"] as const).flatMap((owner) =>
      [false, true].map((updating) => ({ owner, updating })),
    ),
  )(
    "preserves the live $owner owner before snapshots (updating=$updating)",
    async ({ owner, updating }) => {
      const resultPath = updating ? createUpdatePostInstallDoctorResultPath() : undefined;
      const env = {
        OPENCLAW_UPDATE_IN_PROGRESS: updating ? "1" : undefined,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath,
      };
      await withOpenClawTestState({ scenario: "minimal", env }, async (state) => {
        mocks.config.mockReturnValue({});
        mocks.packageRoot.mockReturnValue(undefined);
        const database = openOpenClawStateDatabase({ env: state.env });
        if (owner === "agent") {
          claimOpenClawAgentDatabaseLease({
            agentId: "main",
            path: state.statePath("agents/main/agent/openclaw-agent.sqlite"),
            env: state.env,
          });
        }
        closeOpenClawStateDatabaseByPath(database.path);
        const before = fs.existsSync(state.configPath)
          ? fs.readFileSync(state.configPath, "utf8")
          : undefined;
        const stateOwner =
          owner === "gateway"
            ? acquireGatewayStateOwner({ databasePath: database.path })
            : owner === "schema"
              ? acquireStateDatabaseSchemaLease(database.path)
              : undefined;
        try {
          const gatewayAcquisitions = vi.spyOn(gatewayLock, "acquireGatewayLock");
          await import("../commands/doctor-maintenance.js");
          snapshotProcesses.execFile.mockClear();
          mocks.runContributions.mockClear();
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const failure = await runDoctorHealthFlow(
            runtime,
            {
              repair: true,
              nonInteractive: true,
            },
            undefined,
            { incompatible: [], indeterminate: [] },
          ).catch((error: unknown) => error);
          const result = resultPath
            ? await consumeUpdatePostInstallDoctorResult(resultPath)
            : undefined;
          expect(
            snapshotProcesses.execFile.mock.calls.filter(
              (call) => Array.isArray(call[1]) && call[1].includes(SQLITE_READONLY_CHILD_ARG),
            ),
          ).toEqual([]);
          if (updating) {
            expect(failure).toBeUndefined();
            expect(mocks.runContributions).not.toHaveBeenCalled();
            expect(result).toMatchObject({
              status: "ok",
              configHash: "unchanged",
              maintenanceRefusal: {
                kind: "deferred",
                reason: owner === "agent" ? "agent-database-in-use" : "coordinator-contention",
              },
              warnings: [expect.stringContaining("Doctor could not enter maintenance")],
            });
            expect(runtime.exit).toHaveBeenCalledWith(0);
          } else if (owner === "agent") {
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toBeInstanceOf(UpdateDoctorError);
            expect(collectUpdateDoctorFailureFacts(failure)).toEqual([
              {
                check: "doctor",
                code: "agent-database-lease-active",
                message:
                  "Doctor could not enter maintenance. An agent database is in use. Stop other OpenClaw processes using this state, then retry the update.",
              },
            ]);
          } else {
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).toMatch(/Stop.*service|stop.*process/);
          }
          // Refuse without retrying ownership; snapshot/read startup cost depends on the host.
          expect(gatewayAcquisitions).toHaveBeenCalledOnce();
          expect(
            fs.existsSync(state.configPath) ? fs.readFileSync(state.configPath, "utf8") : undefined,
          ).toBe(before);
        } finally {
          stateOwner?.release();
        }
      });
    },
  );
});

describe("Doctor agent lease admission", () => {
  it("reserves dangling Workshop index admission for Doctor without mutating state", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const opened = openOpenClawStateDatabase({ env: state.env });
      const pathname = opened.path;
      closeOpenClawStateDatabaseByPath(pathname);
      const db = openNodeSqliteDatabase(pathname);
      try {
        db.exec(
          "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
        );
        db.enableDefensive?.(false);
        db.exec("PRAGMA writable_schema = ON;");
        db.prepare(
          `UPDATE sqlite_schema
              SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                           ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
            WHERE type = 'index'
              AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
        ).run();
        const schema = db.prepare("PRAGMA schema_version").get() as { schema_version: number };
        db.exec(
          `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema.schema_version + 1};`,
        );
      } finally {
        db.close();
      }
      const before = fs.readFileSync(pathname);

      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toThrow(
        /legacy-workshop-review-index/,
      );
      expect(fs.readFileSync(pathname)).toEqual(before);
      const doctor = await doctorMaintenance.beginDoctorMaintenance({
        options: { repair: true, nonInteractive: true },
        root: null,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      try {
        expect(doctor).toBeDefined();
        expect(fs.readFileSync(pathname)).toEqual(before);
      } finally {
        await doctor?.release();
      }
    });
  });

  it("admits a restored primary database without opening or clearing its quarantine store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath("state/openclaw.sqlite");
      fs.mkdirSync(state.statePath("state"), { recursive: true });
      const db = openNodeSqliteDatabase(pathname);
      db.exec(
        "PRAGMA user_version=1; CREATE TABLE restored(value TEXT); INSERT INTO restored VALUES ('retained');",
      );
      db.close();
      expect(
        recordOpenClawDatabaseQuarantine({
          env: state.env,
          kind: "state",
          path: pathname,
          reason: "previous corrupt generation",
        }),
      ).toBe(true);
      const quarantine = state.statePath("state/openclaw-quarantine.sqlite");
      const before = [fs.readFileSync(pathname), fs.readFileSync(quarantine)];
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
      expect([fs.readFileSync(pathname), fs.readFileSync(quarantine)]).toEqual(before);
    });
  });
});
