import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  restore: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  record: vi.fn(),
  capture: vi.fn(),
  configCurrent: vi.fn(),
  outcome:
    vi.fn<
      typeof import("../../infra/update-recovery-backup.js").writeUpdateRecoveryBackupOutcome
    >(),
}));
vi.mock("../../infra/update-recovery-backup.js", () => ({
  verifyUpdateRecoveryBackup: mocks.verify,
  restoreUpdateRecoveryBackup: mocks.restore,
  writeUpdateRecoveryBackupOutcome: mocks.outcome,
}));
vi.mock("../../infra/update-run-ledger.js", () => ({
  recordUpdateRunStep: mocks.record,
  recordUpdateRunRecoveryCapture: mocks.capture,
}));
vi.mock("../../infra/update-recovery-config-writes.js", () => ({
  assertUpdateRecoveryConfigUnchanged: mocks.configCurrent,
  withUpdateRecoveryConfigValidation: async (
    _ref: unknown,
    _manifest: unknown,
    _authority: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async () => {},
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  confirmGatewayReachable: async () => ({ reachable: true }),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.resetAllMocks();
  mocks.stop.mockResolvedValue({ stopped: true });
  mocks.restart.mockResolvedValue("ok");
  mocks.outcome.mockImplementation(async (_ref, _outcome, authority) => authority.assertOwned());
});

type RollbackCase = {
  corrupt: boolean;
  stateOnly?: boolean;
  state: "absent" | "newer" | "pending" | "malformed" | "publication";
  failure?: "package" | "restore" | "metadata" | "lost authority" | "config" | "core identity";
};
const cases: RollbackCase[] = [
  { corrupt: false, state: "absent", stateOnly: true },
  { corrupt: false, state: "absent", stateOnly: true, failure: "core identity" },
  { corrupt: false, state: "newer", stateOnly: true, failure: "restore" },
  { corrupt: true, state: "newer", stateOnly: true },
  { corrupt: false, state: "absent" },
  { corrupt: true, state: "absent" },
  { corrupt: false, state: "newer" },
  { corrupt: false, state: "pending" },
  { corrupt: false, state: "malformed" },
  { corrupt: false, state: "publication" },
  { corrupt: false, state: "newer", failure: "package" },
  { corrupt: false, state: "newer", failure: "restore" },
  { corrupt: false, state: "newer", failure: "metadata" },
  { corrupt: false, state: "newer", failure: "lost authority" },
  { corrupt: false, state: "newer", failure: "config" },
];
it.each(cases)(
  "restores migrated state before restarting, corrupt backup=$corrupt, state=$state, failure=$failure, state only=$stateOnly",
  async ({ corrupt, state, failure, stateOnly }) => {
    const root = dirs.make("update-rollback-backup-");
    await fs.mkdir(path.join(root, "tmp"));
    const packageRoot = stateOnly ? path.join(root, "package") : root;
    if (stateOnly) {
      await fs.mkdir(packageRoot);
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
      );
    }
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      path.join(root, "tmp"),
    );
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({ agents: { defaults: { workspace: path.join(root, "workspace") } } }),
    );
    const configSnapshot = await createConfigIO({
      env,
      pluginValidation: "skip",
    }).readConfigFileSnapshot();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    let originalDatabase: Buffer | undefined;
    if (state !== "absent") {
      const database = openOpenClawStateDatabase({ env });
      if (state === "pending") {
        const previous = { root, nodePath: process.execPath, version: "2026.9.3", buildId: null };
        createRetainedUpdateRecovery(
          {
            runId: randomUUID(),
            from: previous,
            to: { ...previous, version: "2026.9.4" },
          },
          { env },
        );
      } else if (state === "malformed") {
        database.db
          .prepare(
            "INSERT INTO config_machine_state (state_key,value_json,updated_at_ms) VALUES (?,?,?)",
          )
          .run(`update.recovery.${randomUUID()}`, "{}", Date.now());
      }
      closeOpenClawStateDatabaseForTest();
      const migrated = new DatabaseSync(databasePath);
      try {
        migrated.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      } finally {
        migrated.close();
      }
      originalDatabase = await fs.readFile(databasePath);
      if (state === "publication") {
        await fs.mkdir(path.join(path.dirname(databasePath), ".openclaw-restore-fixture"));
      }
    }
    const ref = {
      directory: path.join(root, "backup"),
      manifestPath: path.join(root, "backup/manifest.json"),
      manifestSha256: "a".repeat(64),
    };
    mocks.verify.mockResolvedValue({ runId: "fixture-run", installRoot: packageRoot });
    if (corrupt) {
      mocks.verify.mockRejectedValue(new Error("Backup SHA-256 mismatch"));
    }
    let owned = true;
    const assertOwned = () => {
      if (!owned) {
        throw new Error("Executor is no longer current");
      }
    };
    if (failure === "restore" || failure === "metadata" || failure === "lost authority") {
      mocks.restore.mockImplementation(async () => {
        if (failure === "lost authority") {
          owned = false;
        }
        throw new Error("State restore could not finish");
      });
    }
    if (failure === "metadata") {
      mocks.outcome.mockRejectedValue(new Error("Outcome metadata unavailable"));
    }
    if (failure === "config") {
      mocks.configCurrent.mockRejectedValue(
        new Error("Included configuration changed outside the update"),
      );
    }
    const rollback = vi.fn(async () => ({
      name: "package rollback",
      command: "restore",
      cwd: root,
      durationMs: 0,
      exitCode: failure === "package" ? 1 : 0,
      ...(failure === "package" ? { stderrTail: "Package rollback denied" } : {}),
      activePackageRoot: root,
    }));
    const unchangedCore = stateOnly
      ? {
          root: packageRoot,
          fingerprint: await createPackageIntegrityReader().tree(await fs.realpath(packageRoot)),
        }
      : undefined;
    if (failure === "core identity") {
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      );
    }
    const result = await rollbackFailedUpdate({
      result: {
        status: "error",
        mode: "npm",
        root: packageRoot,
        reason: "restart-unhealthy",
        before: { version: "2026.9.3" },
        steps: [],
        durationMs: 0,
      },
      previousRoot: packageRoot,
      previousVerified: true,
      configSnapshot,
      rollbackBlockedReason: "state-migrated-no-rollback",
      updateRecoveryBackup: ref,
      unchangedCore,
      ...(stateOnly
        ? {}
        : {
            packageTransaction: {
              backupRoot: path.join(root, "package-backup"),
              rollback,
              complete: async () => {},
            },
          }),
      preManagedServiceStop: {
        stopped: true,
        running: true,
        inspected: true,
        runtimeInspected: true,
        serviceEnv: env,
      },
      opts: {
        run: { runId: "fixture-run", env, executorFence: { assertCurrent: assertOwned } },
        json: true,
      },
      timeoutMs: 1000,
    });
    if (state === "pending" || state === "malformed" || state === "publication") {
      expect(result.rolledBack).toBe(false);
      expect(rollback).not.toHaveBeenCalled();
      expect(mocks.restore).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(result.pendingRecoveryReason).toMatch(/recovery/i);
      expect(result.pendingRecoveryReason).not.toMatch(/newer schema version/);
    } else if (corrupt || failure) {
      expect(result.rolledBack).toBe(false);
      if (corrupt || failure === "config" || stateOnly) {
        expect(rollback).not.toHaveBeenCalled();
      } else {
        expect(rollback).toHaveBeenCalledOnce();
      }
      if (corrupt || failure === "package" || failure === "config" || failure === "core identity") {
        expect(mocks.restore).not.toHaveBeenCalled();
      }
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(result.pendingRecoveryReason).toContain(ref.manifestPath);
      expect(result.pendingRecoveryReason).toContain("npx openclaw@latest doctor --fix");
    } else {
      expect(result).toMatchObject({
        rolledBack: true,
        stateRestored: true,
        result: { recovery: { service: "healthy" } },
      });
      expect(mocks.restore).toHaveBeenCalledWith(ref, { assertOwned: expect.any(Function) });
      if (stateOnly) {
        expect(rollback).not.toHaveBeenCalled();
      }
      expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restore.mock.invocationCallOrder[0]!,
      );
      expect(mocks.restore.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restart.mock.invocationCallOrder[0]!,
      );
      expect(mocks.record).toHaveBeenCalledWith(
        "fixture-run",
        expect.objectContaining({
          step: "state rollback",
          detail: expect.stringContaining(ref.manifestPath),
        }),
        { env },
      );
      if (state === "newer") {
        await expect(assertUpdateRecoveryAdmission({ env })).rejects.toThrow(
          /newer schema version/,
        );
      }
    }
    if (!result.stateRestored) {
      expect(result.pendingRecoveryReason).toContain(ref.manifestPath);
      expect(result.pendingRecoveryReason).toContain("npx openclaw@latest doctor --fix");
      expect(result.result.steps).toContainEqual(
        expect.objectContaining({
          name: "state rollback",
          command: "npx openclaw@latest doctor --fix",
          stderrTail: expect.stringContaining(ref.manifestPath),
        }),
      );
      expect(mocks.record).not.toHaveBeenCalled();
      if (failure === "lost authority") {
        expect(mocks.outcome).not.toHaveBeenCalled();
        expect(result.pendingRecoveryReason).toContain("Executor is no longer current");
      } else {
        expect(mocks.outcome).toHaveBeenCalledWith(
          ref,
          { status: "restore-failed", error: expect.stringContaining(ref.manifestPath) },
          { assertOwned: expect.any(Function) },
        );
      }
      if (failure && failure !== "package" && failure !== "config" && failure !== "core identity") {
        expect(result.pendingRecoveryReason).toContain("State restore could not finish");
      }
      if (failure === "config") {
        expect(rollback).not.toHaveBeenCalled();
        expect(mocks.restore).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
        expect(result.pendingRecoveryReason).toContain(
          "Included configuration changed outside the update",
        );
      }
      if (failure === "package") {
        expect(result.pendingRecoveryReason).toContain("Package rollback denied");
      }
      if (failure === "metadata") {
        expect(result.pendingRecoveryReason).toContain("Outcome metadata unavailable");
      }
    }
    if (originalDatabase) {
      expect(await fs.readFile(databasePath)).toEqual(originalDatabase);
      await expect(fs.stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
