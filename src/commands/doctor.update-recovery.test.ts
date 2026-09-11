import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import * as updateRunLedger from "../infra/update-run-ledger.js";
import { UNPROTECTED_GATEWAY_UPDATE_ADVISORY } from "../infra/update-run-record.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareDoctorUpdateRecovery, withDoctorUpdateRecovery } from "./doctor-update-recovery.js";
import { doctorCommand } from "./doctor.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  verify: vi.fn(),
  restore: vi.fn(),
  outcome: vi.fn(),
  pending: vi.fn(),
  flow: vi.fn(),
  closeStores: vi.fn(),
  release: vi.fn(),
  driver: vi.fn(),
  activeRuns: vi.fn(),
  gateway: vi.fn(),
  current: vi.fn(),
  enterMaintenance: vi.fn(),
}));

vi.mock("../infra/update-run-driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: mocks.driver,
}));
vi.mock("../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-reader.js")>()),
  listUpdateRunsAsync: mocks.activeRuns,
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: mocks.gateway,
}));

vi.mock("../infra/update-recovery-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-recovery-backup.js")>()),
  createUpdateRecoveryBackup: mocks.create,
  verifyUpdateRecoveryBackup: mocks.verify,
  restoreUpdateRecoveryBackup: mocks.restore,
  writeUpdateRecoveryBackupOutcome: mocks.outcome,
  findPendingUpdateRecoveryBackup: mocks.pending,
  readUpdateRecoveryBackupRef: JSON.parse,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => path.join(process.env.OPENCLAW_STATE_DIR!, "install"),
}));
vi.mock("./doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => {
    await mocks.enterMaintenance();
    return {
      assertCurrent: mocks.current,
      closeStores: mocks.closeStores,
      release: mocks.release,
    };
  },
}));
vi.mock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: mocks.flow }));

describe("update Doctor state recovery", () => {
  let directory: string;
  let configPath: string;
  let backupPath: string;
  let runtime: RuntimeEnv;
  let ref: { directory: string; manifestPath: string; manifestSha256: string };
  let resultPath: string | undefined;
  let runId: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-recovery-"));
    configPath = path.join(directory, "openclaw.json");
    backupPath = path.join(directory, "backup-config.json");
    ref = {
      directory,
      manifestPath: path.join(directory, "manifest.json"),
      manifestSha256: "a".repeat(64),
    };
    await fs.mkdir(path.join(directory, "install"));
    await fs.writeFile(configPath, "{}");
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, undefined);
    const created = updateRunLedger.createUpdateRun({ trigger: "cli" });
    const run = updateRunLedger.recordUpdateRunStep(created.runId, {
      step: "openclaw doctor",
      status: "in_progress",
      startedAtMs: Date.now(),
    });
    runId = run.runId;
    await fs.writeFile(configPath, "original config");
    runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code) => {
        throw new ExitError(code);
      },
    };
    mocks.create.mockImplementation(async () => {
      await fs.copyFile(configPath, backupPath);
      updateRunLedger.recordUpdateRunRecoveryCapture(
        runId,
        { manifestSha256: ref.manifestSha256 },
        () => {},
      );
      return ref;
    });
    mocks.restore.mockImplementation(async () => fs.copyFile(backupPath, configPath));
    mocks.verify.mockResolvedValue({
      stateDir: directory,
      installRoot: path.join(directory, "install"),
      runId,
      creator: { host: "fixture", pid: 42, startIdentity: "1" },
      drivers: [],
    });
    mocks.pending.mockResolvedValue(null);
    mocks.activeRuns.mockImplementation(async () =>
      process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" ? [run] : [],
    );
    mocks.driver.mockReturnValue("dead");
    mocks.gateway.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    if (resultPath) {
      await fs.rm(resultPath, { force: true });
      resultPath = undefined;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function legacyRehearsal(version: string) {
    const parent = readUpdateRunDriver(process.ppid);
    assert(parent, "The tagged rehearsal fixture requires an observable parent");
    const run = updateRunLedger.recordUpdateRunPhase(runId, "validating", {
      before: { version },
      origin: { driver: parent },
    });
    updateRunLedger.recordUpdateRunStep(runId, {
      step: "openclaw doctor",
      status: "completed",
    });
    closeOpenClawStateDatabaseForTest();
    const copyPath = path.join(directory, "openclaw-update-canary-ABC123");
    await fs.mkdir(copyPath, { mode: 0o700 });
    const root = await fs.realpath(copyPath);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.cp(path.join(directory, "state"), path.join(root, "state"), { recursive: true });
    configPath = path.join(root, "openclaw.json");
    const config = {
      agents: {
        defaults: { workspace, cwd: workspace, heartbeat: { every: "0m" } },
        entries: {
          main: {
            workspace: path.join(workspace, "main"),
            cwd: path.join(workspace, "main"),
            agentDir: path.join(root, "agents", "main", "agent"),
            heartbeat: { every: "0m" },
          },
        },
      },
      logging: { file: path.join(root, "canary.log") },
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 19876,
        auth: { mode: "token", token: "00000000-0000-4000-8000-000000000001" },
        tls: { enabled: false },
        tailscale: { mode: "off" },
        controlUi: { enabled: false },
      },
      cron: { enabled: false, triggers: { enabled: false } },
      hooks: { enabled: false, internal: { enabled: false } },
      transcripts: { enabled: false, autoStart: [] },
      discovery: { mdns: { mode: "off" } },
    };
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const env = {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspace,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: "1",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    for (const key of [
      ...SUPERVISOR_HINT_ENV_VARS,
      "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_GATEWAY_SERVICE_PID",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_COMPATIBILITY_HOST_VERSION",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_PROFILE",
      "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "OPENCLAW_OAUTH_DIR",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    mocks.activeRuns.mockResolvedValue([
      {
        ...run,
        steps: run.steps.filter((step) => step.step !== "openclaw doctor"),
      },
    ]);
    mocks.driver.mockReturnValue("alive");
    return { root, config };
  }

  it.each(["2026.9.3", "2026.9.4"])(
    "admits the shipped %s rehearsal copy and reports its typed admission",
    async (version) => {
      const { root } = await legacyRehearsal(version);
      const liveConfig = await fs.readFile(path.join(directory, "openclaw.json"));
      await doctorCommand(runtime, { repair: true, nonInteractive: true });
      expect(mocks.flow).toHaveBeenCalledOnce();
      expect(runtime.log).toHaveBeenCalledWith(
        JSON.stringify({
          kind: "legacy-driver-rehearsal",
          driverStyle: "2026.9.3",
          message:
            "legacy driver rehearsal admitted: 2026.9.3-style invocation, disposable copy verified",
          stateDir: root,
        }),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Warning: legacy driver rehearsal admitted"),
      );
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(directory, "openclaw.json"))).toEqual(liveConfig);
    },
  );

  it("keeps an identity-bearing rehearsal invocation on strict driver admission", async () => {
    await legacyRehearsal("2026.9.3");
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", runId);
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "Doctor cannot identify one admitted update run with an active Doctor step",
    );
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("refuses the legacy marker against live state without rehearsal facts", async () => {
    mocks.activeRuns.mockResolvedValue([]);
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "Doctor cannot identify one admitted update run with an active Doctor step",
    );
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
  });

  it.each(["config symlink", "database hardlink", "live home", "foreign parent"] as const)(
    "refuses a rehearsal with %s before running Doctor",
    async (fault) => {
      const { root } = await legacyRehearsal("2026.9.3");
      if (fault === "config symlink") {
        const outside = path.join(directory, "outside-config.json");
        await fs.rename(configPath, outside);
        await fs.symlink(outside, configPath);
      } else if (fault === "database hardlink") {
        await fs.link(
          path.join(root, "state", "openclaw.sqlite"),
          path.join(directory, "live.sqlite"),
        );
      } else if (fault === "live home") {
        vi.stubEnv("HOME", directory);
      } else {
        mocks.activeRuns.mockResolvedValue([]);
      }
      const liveConfig = await fs.readFile(path.join(directory, "openclaw.json"));
      await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
        "Legacy update rehearsal was refused",
      );
      expect(mocks.flow).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(directory, "openclaw.json"))).toEqual(liveConfig);
    },
  );

  it.each(["-wal", "-shm", "-journal"])(
    "refuses a linked SQLite companion substituted during admission: %s",
    async (suffix) => {
      const { root } = await legacyRehearsal("2026.9.3");
      const outside = path.join(directory, "live-companion");
      await fs.writeFile(outside, "live data");
      mocks.enterMaintenance.mockImplementation(async () => {
        closeOpenClawStateDatabaseForTest();
        const companion = `${path.join(root, "state", "openclaw.sqlite")}${suffix}`;
        await fs.rm(companion, { force: true });
        await fs.symlink(outside, companion);
      });
      await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
        "copied data has unsafe ownership or links",
      );
      expect(mocks.flow).not.toHaveBeenCalled();
      expect(await fs.readFile(outside, "utf8")).toBe("live data");
    },
  );

  it("refuses an OAuth directory outside the rehearsal copy", async () => {
    await legacyRehearsal("2026.9.3");
    const outside = path.join(directory, "live-oauth");
    await fs.mkdir(outside);
    vi.stubEnv("OPENCLAW_OAUTH_DIR", outside);
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "migration data escapes the copied state",
    );
    expect(mocks.flow).not.toHaveBeenCalled();
  });

  it.each(["declared", "undeclared", "wrong parent"] as const)(
    "accepts only an explicitly unprotected Doctor with its actual parent: %s",
    async (declaration) => {
      const parent = readUpdateRunDriver(process.ppid);
      assert(parent, "The fixture requires an observable actual parent");
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", runId);
      mocks.driver.mockReturnValue("alive");
      const owner =
        declaration === "wrong parent"
          ? { ...parent, startIdentity: String(Number(parent.startIdentity) + 1) }
          : parent;
      updateRunLedger.recordUpdateRunPhase(runId, "staging", {
        trigger: "api",
        target: { kind: "git" },
        origin: {
          driver: owner,
          ...(declaration !== "undeclared" ? { unprotectedGatewayUpdate: { owner } } : {}),
        },
      });
      const run = () =>
        doctorCommand(runtime, {
          repair: true,
          nonInteractive: true,
          updateRecoveryOwner: "unprotected",
        });
      if (declaration === "declared") {
        await expect(run()).resolves.toBeUndefined();
        expect(mocks.flow).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledWith(UNPROTECTED_GATEWAY_UPDATE_ADVISORY);
      } else {
        await expect(run()).rejects.toThrow(
          declaration === "wrong parent"
            ? "Unprotected Gateway update requires its live, explicitly declared parent run."
            : "Unprotected Doctor requires an explicitly declared Gateway update parent.",
        );
        expect(mocks.flow).not.toHaveBeenCalled();
      }
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(mocks.outcome).not.toHaveBeenCalled();
      expect(updateRunLedger.getUpdateRun(runId)?.status).toBe("running");
      expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    },
  );

  it.each(["throw", "nonzero exit"])(
    "restores before propagating a Doctor %s and retains recovery guidance",
    async (failure) => {
      mocks.flow.mockImplementation(async (flowRuntime: RuntimeEnv) => {
        await fs.writeFile(configPath, "migrated config");
        if (failure === "nonzero exit") {
          flowRuntime.exit(1);
        }
        throw new Error("post-migration verification failed");
      });
      await expect(
        doctorCommand(runtime, { repair: true, nonInteractive: true }),
      ).rejects.toThrow();
      expect(await fs.readFile(configPath, "utf8")).toBe("original config");
      expect(await fs.readFile(backupPath, "utf8")).toBe("original config");
      const restoreOrder = mocks.restore.mock.invocationCallOrder[0];
      assert(restoreOrder !== undefined, "Doctor must restore failed migrations");
      expect(mocks.closeStores.mock.invocationCallOrder[0]).toBeLessThan(restoreOrder);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw gateway start"));
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("npx openclaw@latest doctor --fix"),
      );
      expect(mocks.outcome).toHaveBeenCalledWith(
        ref,
        { status: "restored" },
        {
          assertOwned: expect.any(Function),
        },
      );
    },
  );

  it("leaves successful migrations protected until the parent updater settles", async () => {
    mocks.flow.mockImplementation(async () => fs.writeFile(configPath, "migrated config"));
    await doctorCommand(runtime, { repair: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("migrated config");
    expect(await fs.readFile(backupPath, "utf8")).toBe("original config");
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.outcome).not.toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ status: "committed" }),
      expect.anything(),
    );
    expect(updateRunLedger.getUpdateRun(runId)).toMatchObject({
      status: "running",
      origin: {
        updateRecoveryCapture: { doctorCompleted: true, manifestSha256: ref.manifestSha256 },
      },
    });
  });

  it("keeps a successful Doctor successful when its completion receipt cannot be recorded", async () => {
    mocks.flow.mockImplementation(async () => fs.writeFile(configPath, "migrated config"));
    const recordCapture = updateRunLedger.recordUpdateRunRecoveryCapture;
    vi.spyOn(updateRunLedger, "recordUpdateRunRecoveryCapture").mockImplementation((...args) => {
      if (args[1].doctorCompleted) {
        throw new Error("outcome publication failed");
      }
      return recordCapture(...args);
    });
    await expect(doctorCommand(runtime, { repair: true })).resolves.toBeUndefined();
    expect(await fs.readFile(configPath, "utf8")).toBe("migrated config");
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("capture outcome could not be recorded"),
    );
  });

  it("restores state before failing when Doctor cannot close its stores", async () => {
    mocks.flow.mockImplementation(async () => fs.writeFile(configPath, "migrated config"));
    mocks.closeStores.mockRejectedValueOnce(new Error("store close failed"));
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow("store close failed");
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
  });

  it("restores bootstrap writes when startup fails before Doctor is reached", async () => {
    await expect(
      withDoctorUpdateRecovery(runtime, async () => {
        await prepareDoctorUpdateRecovery({ repair: true });
        await fs.writeFile(configPath, "bootstrap migration");
        throw new Error("bootstrap failed");
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    expect(mocks.flow).not.toHaveBeenCalled();
  });

  it("reports the restored config hash so an older updater still owns package rollback", async () => {
    resultPath = createUpdatePostInstallDoctorResultPath();
    const outputPath = resultPath;
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, outputPath);
    mocks.flow.mockImplementation(async () => {
      await fs.writeFile(configPath, "migrated config");
      await writeUpdatePostInstallDoctorResult({
        resultPath: outputPath,
        result: {
          status: "error",
          configInputHash: hashConfigRaw("original config"),
          configHash: hashConfigRaw("migrated config"),
          warnings: ["fixture advisory"],
        },
      });
      throw new Error("verification failed after config migration");
    });
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow("verification failed");
    expect(await consumeUpdatePostInstallDoctorResult(outputPath)).toEqual({
      status: "error",
      configInputHash: hashConfigRaw("original config"),
      configHash: hashConfigRaw("original config"),
      warnings: ["fixture advisory"],
    });
  });

  it("leaves restore ownership with a driver whose backup verifies", async () => {
    mocks.flow.mockRejectedValue(new Error("verification failed"));
    await expect(
      doctorCommand(runtime, {
        repair: true,
        updateRecoveryOwner: "driver",
        updateRecoveryBackup: JSON.stringify(ref),
      }),
    ).rejects.toThrow("verification failed");
    expect(mocks.verify).toHaveBeenCalledWith(ref);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.outcome).not.toHaveBeenCalled();
  });

  it("refuses an unverified driver backup before migrations", async () => {
    mocks.verify.mockRejectedValue(new Error("backup digest mismatch"));
    await expect(
      doctorCommand(runtime, {
        repair: true,
        updateRecoveryOwner: "driver",
        updateRecoveryBackup: JSON.stringify(ref),
      }),
    ).rejects.toThrow("backup digest mismatch");
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
  });

  it("rejects an incomplete driver marker before preparing the recovery scope", async () => {
    await withDoctorUpdateRecovery(runtime, async () => {
      await expect(
        prepareDoctorUpdateRecovery({
          repair: true,
          updateRecoveryOwner: "driver",
        }),
      ).rejects.toThrow("both the driver owner and a backup reference");
      await prepareDoctorUpdateRecovery({
        repair: true,
        updateRecoveryOwner: "driver",
        updateRecoveryBackup: JSON.stringify(ref),
      });
    });
    expect(mocks.verify).toHaveBeenCalledWith(ref);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a backup reference without its driver marker", async () => {
    await expect(
      doctorCommand(runtime, {
        repair: true,
        updateRecoveryBackup: JSON.stringify(ref),
      }),
    ).rejects.toThrow("both the driver owner and a backup reference");
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps restore failure fatal with the exact retry command", async () => {
    mocks.flow.mockRejectedValue(new Error("migration failed"));
    mocks.restore.mockRejectedValue(new Error("backup volume unavailable"));
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "npx openclaw@latest doctor --fix",
    );
    expect(mocks.outcome).toHaveBeenCalledWith(
      ref,
      {
        status: "restore-failed",
        error: "Error: backup volume unavailable",
      },
      { assertOwned: expect.any(Function) },
    );
  });

  it("preserves the Doctor failure when restored-outcome reporting fails", async () => {
    const failure = new Error("Doctor verification failed");
    mocks.flow.mockImplementation(async () => {
      await fs.writeFile(configPath, "migrated config");
      throw failure;
    });
    mocks.outcome.mockImplementation(async (_ref: unknown, outcome: { status: string }) => {
      if (outcome.status === "restored") {
        throw new Error("outcome publication failed");
      }
    });
    await expect(doctorCommand(runtime, { repair: true })).rejects.toBe(failure);
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    expect(mocks.outcome.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ status: "restore-failed" }),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("State was restored, but its backup outcome could not be recorded"),
    );
  });

  it("reports blocked rollback confirmation without misreporting a successful data restore", async () => {
    const failure = new Error("Doctor verification failed");
    vi.stubEnv(
      UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
      path.join(directory, "invalid-result.json"),
    );
    mocks.flow.mockImplementation(async () => {
      await fs.writeFile(configPath, "migrated config");
      throw failure;
    });
    await expect(doctorCommand(runtime, { repair: true })).rejects.toBe(failure);
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    expect(mocks.outcome).toHaveBeenCalledWith(
      ref,
      { status: "restored" },
      {
        assertOwned: expect.any(Function),
      },
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("package rollback confirmation may be blocked"),
    );
  });

  it("keeps lost authority fatal after a successful data restore", async () => {
    mocks.flow.mockRejectedValue(new Error("Doctor verification failed"));
    mocks.outcome.mockImplementation(async (_ref: unknown, outcome: { status: string }) => {
      if (outcome.status === "restored") {
        mocks.current.mockImplementation(() => {
          throw new Error("Doctor maintenance authority expired");
        });
        throw new Error("outcome publication failed");
      }
    });
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "Doctor maintenance authority expired",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("State was restored, but its backup outcome could not be recorded"),
    );
  });

  it("refuses pending manual recovery beside a retained legacy checkpoint", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    const stateParent = path.join(directory, "state");
    const retained = path.join(stateParent, ".openclaw-restore-fixture");
    await fs.writeFile(retained, "retained checkpoint");
    await fs.writeFile(backupPath, "original config");
    await fs.writeFile(configPath, "partially migrated config");
    mocks.pending.mockResolvedValue(ref);
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "publication is read-only",
    );
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.flow).not.toHaveBeenCalled();
    expect(await fs.readFile(retained, "utf8")).toBe("retained checkpoint");
    expect(await fs.readFile(configPath, "utf8")).toBe("partially migrated config");
  });

  it("restores an interrupted update before newer Doctor repair", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    await fs.writeFile(backupPath, "original config");
    await fs.writeFile(configPath, "partially migrated config");
    mocks.pending.mockResolvedValue(ref);
    mocks.flow.mockImplementation(async () => {
      expect(await fs.readFile(configPath, "utf8")).toBe("original config");
      await fs.writeFile(configPath, "repaired config");
    });
    await doctorCommand(runtime, { repair: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("repaired config");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.outcome).toHaveBeenCalledWith(
      ref,
      { status: "restored" },
      {
        assertOwned: expect.any(Function),
      },
    );
  });

  it.each(["repair", "bootstrap"])(
    "restores the claimed capture again after subsequent %s fails",
    async (phase) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
      await fs.writeFile(backupPath, "original config");
      await fs.writeFile(configPath, "partially migrated config");
      mocks.pending.mockResolvedValue(ref);
      let terminalBeforeRepair = false;
      const mutateAndFail = async () => {
        expect(await fs.readFile(configPath, "utf8")).toBe("original config");
        terminalBeforeRepair = mocks.outcome.mock.calls.length > 0;
        await fs.writeFile(configPath, "second partial migration");
        throw new Error("continued repair failed");
      };
      mocks.flow.mockImplementation(mutateAndFail);
      const operation =
        phase === "repair"
          ? doctorCommand(runtime, { repair: true })
          : withDoctorUpdateRecovery(runtime, async () => {
              await prepareDoctorUpdateRecovery({ repair: true });
              await mutateAndFail();
            });

      await expect(operation).rejects.toThrow("continued repair failed");
      expect(await fs.readFile(configPath, "utf8")).toBe("original config");
      expect(terminalBeforeRepair).toBe(false);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.restore).toHaveBeenCalledTimes(2);
      expect(mocks.closeStores).toHaveBeenCalledTimes(2);
      const closeOrder = mocks.closeStores.mock.invocationCallOrder[1];
      const restoreOrder = mocks.restore.mock.invocationCallOrder[1];
      assert(closeOrder !== undefined && restoreOrder !== undefined, "Recovery must settle stores");
      expect(closeOrder).toBeLessThan(restoreOrder);
      expect(mocks.outcome).toHaveBeenCalledExactlyOnceWith(
        ref,
        { status: "restored" },
        { assertOwned: expect.any(Function) },
      );
    },
  );

  it.each(["alive", "unknown"])(
    "refuses a retained backup with a %s original owner",
    async (liveness) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
      mocks.pending.mockResolvedValue(ref);
      mocks.driver.mockReturnValue(liveness);
      await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
        "live or unobservable owner",
      );
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(mocks.flow).not.toHaveBeenCalled();
      expect(await fs.readFile(configPath, "utf8")).toBe("original config");
    },
  );

  it("refuses retained recovery while a Gateway is running", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    mocks.pending.mockResolvedValue(ref);
    mocks.gateway.mockResolvedValue({ pid: 42, port: 12345 });
    await expect(doctorCommand(runtime, { repair: true })).rejects.toThrow(
      "while the Gateway is running",
    );
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.flow).not.toHaveBeenCalled();
  });
});
