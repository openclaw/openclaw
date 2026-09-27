import "./doctor-health.test-support.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import * as coordinators from "../infra/state-database-coordinator.js";
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
  run: <T>(operation: () => T): T => operation(),
  finish: vi.fn(),
  releaseState: vi.fn(),
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
afterEach(() => vi.restoreAllMocks());

describe("Doctor refused-migration maintenance outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(maintenance);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
  });

  it("unwinds a repair runtime exit through maintenance restoration", async () => {
    mocks.runContributions.mockImplementationOnce(async (ctx) => ctx.runtime.exit(130));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await expect(
      runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
    ).rejects.toEqual(new ExitError(130));
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(
      undefined,
      undefined,
      new ExitError(130),
    );
    expect(maintenance.release).toHaveBeenCalledOnce();
  });

  it("forwards database write proof produced while failed Doctor maintenance settles", async () => {
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
        vi.mocked(doctorMaintenance.beginDoctorMaintenance).mockResolvedValueOnce({
          ...maintenance,
          get databaseWrites() {
            return released ? databaseWrites : undefined;
          },
          release: async () => {
            released = true;
          },
        });
        const failure = new Error("injected post-migration Doctor failure");
        mocks.runContributions.mockRejectedValueOnce(failure);
        await expect(
          runDoctorHealthFlow(
            { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            { repair: true, nonInteractive: true },
            { inputHash: hashConfigRaw(null), assertCurrent() {}, databaseGenerations },
          ),
        ).rejects.toBe(failure);
        expect(doctorMaintenance.beginDoctorMaintenance).toHaveBeenCalledWith(
          expect.objectContaining({ databaseGenerations }),
        );
        await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toMatchObject({
          status: "error",
          databaseWrites,
        });
      },
    );
  });

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
          await expect(
            runDoctorHealthFlow(
              { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
              { repair: true, nonInteractive: true },
            ),
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

  it.each([true, false])(
    "passes maintenance its failure before releasing custody (migration refusal=%s)",
    async (migrationRefusal) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({ gateway: { mode: "local" } });
        const failure = migrationRefusal
          ? new DoctorStateMigrationRefusalError([])
          : new Error("diagnostic failed");
        mocks.runContributions.mockRejectedValueOnce(failure);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await expect(
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        ).rejects.toBe(failure);
        expect(maintenance.release).toHaveBeenCalledOnce();
        expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(undefined, undefined, failure);
        expect(mocks.outro).not.toHaveBeenCalled();
        if (migrationRefusal) {
          expect(runtime.error).not.toHaveBeenCalled();
        } else {
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Check the reported service state"),
          );
        }
      });
    },
  );
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
    (["gateway", "state", "agent"] as const).flatMap((owner) =>
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
        const gatewayAcquisitions = vi.spyOn(coordinators, "acquireGatewayMaintenanceCoordinator");
        const stateAcquisitions = vi.spyOn(coordinators, "acquireStateDatabaseCoordinator");
        if (owner !== "agent") {
          (owner === "gateway" ? gatewayAcquisitions : stateAcquisitions).mockImplementation(() => {
            throw new coordinators.StateDatabaseCoordinatorContentionError(
              owner === "gateway" ? "gateway-lifecycle" : "state-lifecycle",
            );
          });
        }
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
        expect(stateAcquisitions).toHaveBeenCalledTimes(owner === "gateway" ? 0 : 1);
        expect(
          fs.existsSync(state.configPath) ? fs.readFileSync(state.configPath, "utf8") : undefined,
        ).toBe(before);
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
