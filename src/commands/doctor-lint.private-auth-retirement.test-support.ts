import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, vi, type Mock } from "vitest";
import { acquireAuthProfileReadDatabase } from "../agents/auth-profiles/sqlite-read-pool.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import type { HealthCheck } from "../flows/health-checks.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { removeTempDirectoryAsync } from "../infra/sqlite-readonly-location-cleanup.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { snapshotDoctorLintSqliteFamily } from "./doctor-lint.test-support.js";

export async function verifyDoctorLintPrivateAuthRetirement(
  runtime: RuntimeEnv,
  mode: "reader-close-finding" | "reader-close-full-finding" | "writer-close" | "cleanup-detector",
  installHealthChecks: (checks: HealthCheck[]) => void,
  sqliteOpen: Mock<(filename: string, readOnly: boolean, database: DatabaseSync) => void>,
): Promise<void> {
  const windows = process.platform === "win32";
  const denied = { code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/) };
  const unchanged = { value: "unchanged" };
  const env = { OPENCLAW_UPDATE_IN_PROGRESS: "1" };
  await withOpenClawTestState({ prefix: "doctor-retirement-", env }, async (state) => {
    await state.writeConfig({ memory: { search: { enabled: false } } });
    const source = openOpenClawStateDatabase();
    const before = snapshotDoctorLintSqliteFamily(source.path);
    const sourceConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const openAuthReader = (filename: string) => {
      {
        using database = openNodeSqliteDatabase(filename);
        database.exec("CREATE TABLE fixture AS SELECT 'unchanged' AS value");
      }
      const reader = acquireAuthProfileReadDatabase(filename, openSqliteReadOnlyDatabase);
      if (reader.status !== "readable") {
        throw new Error("auth reader fixture is not readable");
      }
      return reader.db;
    };
    const callerPath = state.path("caller-auth.sqlite");
    const callerReader = openAuthReader(callerPath);
    const callerBefore = fs.readFileSync(callerPath);
    let privateState: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    let privateRead: ReturnType<typeof openOpenClawStateReadConnection> | undefined;
    let auth: DatabaseSync | undefined;
    let blocker: DatabaseSync | undefined;
    let blockerPath: string | undefined;
    const removalErrors: unknown[] = [];
    let unregister: (() => void) | undefined;
    let restoreAuthClose: (() => void) | undefined;
    let denyWriter = mode.startsWith("writer-close");
    const cleanupFailure = mode.startsWith("cleanup");
    const readerFailure = mode.startsWith("reader-close");
    const checkId = "core/doctor/runtime-tool-schemas";
    const detectorFinding = {
      checkId,
      severity: "error" as const,
      message: "synthetic authoritative detector finding",
      path: "synthetic.detector.path",
    };
    const closeError = `synthetic ${mode} retirement failure`;
    async function detect() {
      writeConfigMachineState("doctorLint.synthetic.privateWrite", true);
      const writer = openOpenClawStateDatabase();
      const reader = openOpenClawStateReadConnection(writer.path, writer.path);
      const admission = captureOpenClawStateDatabaseReadAdmission(writer.path);
      privateState = writer;
      privateRead = reader;
      const privateStateDir = path.dirname(writer.path);
      const privateAuthPath = path.join(privateStateDir, "private-auth.sqlite");
      auth = openAuthReader(privateAuthPath);
      if (windows) {
        // Native Windows must reject unlinking the pooled reader, never skip this gate.
        await expect(remove(privateAuthPath, { force: true })).rejects.toMatchObject(denied);
        expect(auth.prepare("SELECT value FROM fixture").get()).toEqual(unchanged);
        if (cleanupFailure) {
          // Unowned handle blocks cleanup even after Doctor retires its handles.
          blockerPath = path.join(privateStateDir, "held-cleanup.sqlite");
          blocker = openNodeSqliteDatabase(blockerPath);
          blocker.exec("CREATE TABLE fixture AS SELECT 1 AS value");
        }
      }
      if (readerFailure) {
        const close = vi.spyOn(auth, "close").mockImplementationOnce(() => {
          throw new Error(closeError);
        });
        restoreAuthClose = () => close.mockRestore();
      }
      unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(identity) {
          if (identity !== undefined && identity.key !== admission.identity.key) {
            return;
          }
          if (denyWriter) {
            denyWriter = false;
            throw new Error(closeError);
          }
          await Promise.resolve();
          reader.close();
        },
      });
      if (cleanupFailure) {
        throw new Error("synthetic authoritative detector failure");
      }
      return readerFailure ? [detectorFinding] : [];
    }
    installHealthChecks([{ id: checkId, kind: "core", description: checkId, detect }]);
    const remove = fs.promises.rm;
    const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const prefix = `${String(target)}${path.sep}`;
      if (!windows) {
        // POSIX permits unlinking open files; only non-Windows uses the simulator.
        const openHandle = sqliteOpen.mock.calls.some(
          ([file, , db]) => file.startsWith(prefix) && db.isOpen,
        );
        if (openHandle || cleanupFailure) {
          const message = openHandle ? "Open native SQLite handle" : "Synthetic removal failure";
          throw Object.assign(new Error(message), { code: "EPERM" });
        }
      }
      return remove(target, options).catch((error: unknown) => {
        removalErrors.push(error);
        throw error;
      });
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        ...(mode === "reader-close-full-finding"
          ? { includeAllChecks: true }
          : { onlyIds: [checkId] }),
      });
      expect(exitCode).toBe(1);
      const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(report).toMatchObject({ schemaVersion: 1, ok: false });
      const failure = expect.objectContaining({
        severity: "error",
        message: !cleanupFailure
          ? expect.stringContaining(closeError)
          : "health check threw: synthetic authoritative detector failure",
      });
      if (readerFailure) {
        expect(report.findings).toEqual(expect.arrayContaining([detectorFinding, failure]));
        expect(report.findings).toHaveLength(2);
        // Disposal must retain the completed report's count, including plugin checks.
        expect(report.checksRun).toBeGreaterThan(0);
      } else {
        expect(report.findings).toEqual([failure]);
        expect(report.findings[0]).toMatchObject({ checkId });
      }
      expect(privateState).toBeDefined();
      const snapshotRoot = path.dirname(resolveOpenClawStateDirForDatabasePath(privateState!.path));
      if (!cleanupFailure) {
        // A separate full-report snapshot may retire, but not this failed snapshot or its family.
        expect(
          removal.mock.calls
            .map(([target]) => path.resolve(String(target)))
            .filter(
              (target) =>
                target === snapshotRoot ||
                target.startsWith(`${snapshotRoot}${path.sep}`) ||
                snapshotRoot.startsWith(`${target}${path.sep}`),
            ),
        ).toEqual([]);
      }
      if (windows) {
        expect(removalErrors).toMatchObject(cleanupFailure ? [denied] : []);
        if (cleanupFailure) {
          expect([blocker?.isOpen, fs.existsSync(blockerPath!)]).toEqual([true, true]);
        }
      }
      expect(report.warnings ?? []).toMatchObject(
        cleanupFailure ? [{ requirement: "temporary-snapshot-cleanup", severity: "warning" }] : [],
      );
      expect(auth?.isOpen).toBe(readerFailure);
      if (readerFailure || cleanupFailure) {
        expect([privateState?.db.isOpen, privateRead?.database.db.isOpen]).toEqual([false, false]);
      }
      // Recursive removal can partially succeed before a genuine Windows denial.
      expect(fs.existsSync(snapshotRoot)).toBe(true);
      if (!windows || !cleanupFailure) {
        expect(fs.existsSync(privateState!.path)).toBe(true);
      }
      expect([source.db.isOpen, callerReader.isOpen]).toEqual([true, true]);
      expect(callerReader.prepare("SELECT value FROM fixture").get()).toEqual(unchanged);
      expect(fs.readFileSync(callerPath)).toEqual(callerBefore);
      expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(before);
      expect(readConfigMachineState("doctorLint.synthetic.privateWrite")).toBeUndefined();
      expect(process.env).toMatchObject({
        OPENCLAW_STATE_DIR: state.stateDir,
        OPENCLAW_CONFIG_PATH: sourceConfigPath,
      });
    } finally {
      stdout.mockRestore();
      removal.mockRestore();
      restoreAuthClose?.();
      sqliteOpen.mockReset();
      blocker?.close();
      privateRead?.close();
      if (privateState) {
        const rootPath = resolveOpenClawStateDirForDatabasePath(privateState.path);
        closeAuthProfileReadPool({ kind: "root", rootPath });
        await closeOpenClawStateDatabaseByPathAsync(privateState.path);
        // Retained snapshots still own native staging tokens after injected failures.
        expect(await removeTempDirectoryAsync(path.dirname(rootPath))).toBe(true);
      }
      unregister?.();
      closeAuthProfileReadPool({ kind: "root", rootPath: state.root });
    }
  });
}
