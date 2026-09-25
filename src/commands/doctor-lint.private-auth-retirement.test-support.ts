import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, vi, type Mock } from "vitest";
import { acquireAuthProfileReadDatabase } from "../agents/auth-profiles/sqlite-read-pool.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import type { HealthCheck, HealthFinding } from "../flows/health-checks.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { removeTempDirectoryAsync } from "../infra/sqlite-readonly-location-cleanup.js";
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
  mode:
    | "normal"
    | "update"
    | "reader-close"
    | "reader-close-detector"
    | "reader-close-finding"
    | "reader-close-full-finding"
    | "writer-close-detector"
    | "writer-close"
    | "detector"
    | "cleanup"
    | "cleanup-detector",
  installHealthChecks: (checks: HealthCheck[]) => void,
  sqliteOpen: Mock<(filename: string, readOnly: boolean, database: DatabaseSync) => void>,
): Promise<void> {
  const nativeWindows = process.platform === "win32";
  const env = { OPENCLAW_UPDATE_IN_PROGRESS: mode === "normal" ? undefined : "1" };
  await withOpenClawTestState({ prefix: "doctor-retirement-", env }, async (state) => {
    await state.writeConfig({ memory: { search: { enabled: false } } });
    const source = openOpenClawStateDatabase();
    const before = snapshotDoctorLintSqliteFamily(source.path);
    const sourceConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const openAuthReader = (filename: string) => {
      // Minimal native SQLite fixture for the actual pooled auth reader lifecycle.
      const database = openNodeSqliteDatabase(filename);
      try {
        database.exec("CREATE TABLE fixture AS SELECT 'unchanged' AS value");
      } finally {
        database.close();
      }
      const reader = acquireAuthProfileReadDatabase(filename);
      if (reader.status !== "readable") {
        throw new Error("auth reader fixture is not readable");
      }
      return reader.db;
    };
    const callerPath = state.path("caller-auth.sqlite");
    const callerReader = openAuthReader(callerPath);
    const callerBefore = fs.readFileSync(callerPath);
    let privateWriter: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    let privateReader: ReturnType<typeof openOpenClawStateReadConnection> | undefined;
    let privateAuth: DatabaseSync | undefined;
    let nativeCleanupBlocker: DatabaseSync | undefined;
    let nativeCleanupBlockerPath: string | undefined;
    let nativeOpenHandleRefused = false;
    const nativeRemovalErrors: unknown[] = [];
    let unregister: (() => void) | undefined;
    let restoreAuthClose: (() => void) | undefined;
    let removedSnapshot = false;
    let denyWriter = mode.startsWith("writer-close");
    const cleanupFailure = mode.startsWith("cleanup");
    const detectorFailure = mode.endsWith("detector");
    const retirementFailure = mode.includes("-close");
    const readerRetirementFailure = mode.startsWith("reader-close");
    const returnedFinding = mode.endsWith("finding");
    const detectorFinding: HealthFinding = {
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message: "synthetic authoritative detector finding",
      path: "synthetic.detector.path",
    };
    const checkId = "core/doctor/runtime-tool-schemas";
    const closeError = `synthetic ${mode} retirement failure`;
    installHealthChecks([
      {
        id: checkId,
        kind: "core",
        description: "inspects private runtime state",
        async detect() {
          writeConfigMachineState("doctorLint.synthetic.privateWrite", true);
          const writer = openOpenClawStateDatabase();
          const reader = openOpenClawStateReadConnection(writer.path, writer.path);
          const admission = captureOpenClawStateDatabaseReadAdmission(writer.path);
          privateWriter = writer;
          privateReader = reader;
          const privateStateDir = path.dirname(writer.path);
          const privateAuthPath = path.join(privateStateDir, "private-auth.sqlite");
          privateAuth = openAuthReader(privateAuthPath);
          if (nativeWindows) {
            // Call the real filesystem while the real pooled SQLite reader is open.
            // A runner that permits deletion must fail this gate, never skip it.
            await expect(remove(privateAuthPath, { force: true })).rejects.toMatchObject({
              code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/),
            });
            expect(privateAuth.prepare("SELECT value FROM fixture").get()).toEqual({
              value: "unchanged",
            });
            nativeOpenHandleRefused = true;
            if (cleanupFailure) {
              // Deliberately unowned by Doctor: real Windows cleanup denial after
              // Doctor has retired all its own readers and writers.
              nativeCleanupBlockerPath = path.join(privateStateDir, "held-cleanup.sqlite");
              nativeCleanupBlocker = openNodeSqliteDatabase(nativeCleanupBlockerPath);
              nativeCleanupBlocker.exec("CREATE TABLE fixture AS SELECT 1 AS value");
            }
          }
          // Reader/writer retirement failures remain explicit synthetic injections.
          if (readerRetirementFailure) {
            const close = vi.spyOn(privateAuth, "close").mockImplementationOnce(() => {
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
          if (detectorFailure) {
            throw new Error("synthetic authoritative detector failure");
          }
          return returnedFinding ? [detectorFinding] : [];
        },
      },
    ]);
    const remove = fs.promises.rm;
    const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const prefix = `${String(target)}${path.sep}`;
      if (!nativeWindows) {
        // POSIX permits unlinking open files; only non-Windows uses the simulator.
        const openHandle = sqliteOpen.mock.calls.some(
          ([file, , db]) => file.startsWith(prefix) && db.isOpen,
        );
        if (openHandle || cleanupFailure) {
          const message = openHandle ? "Open native SQLite handle" : "Synthetic removal failure";
          throw Object.assign(new Error(message), { code: "EPERM" });
        }
      }
      try {
        await remove(target, options);
      } catch (error) {
        if (nativeWindows) {
          nativeRemovalErrors.push(error);
        }
        throw error;
      }
      removedSnapshot ||= Boolean(privateWriter?.path.startsWith(prefix));
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        ...(mode === "reader-close-full-finding"
          ? { includeAllChecks: true }
          : { onlyIds: [checkId] }),
      });
      expect(exitCode).toBe(retirementFailure || detectorFailure ? 1 : 0);
      const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(report.schemaVersion).toBe(1);
      expect(report.ok).toBe(!retirementFailure && !detectorFailure);
      if (returnedFinding) {
        expect(report.findings).toContainEqual(detectorFinding);
        expect(report.findings).toContainEqual(
          expect.objectContaining({
            severity: "error",
            message: expect.stringContaining(closeError),
          }),
        );
        expect(report.findings).toHaveLength(2);
        // A completed full report can include registered plugin checks too;
        // snapshot disposal must not replace its count with generic failure's zero.
        expect(report.checksRun).toBeGreaterThan(0);
      } else if (retirementFailure && detectorFailure) {
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0]).toMatchObject({ checkId, severity: "error" });
        expect(report.findings[0].message).toContain("synthetic authoritative detector failure");
        expect(report.findings[0].message).toContain(closeError);
      } else {
        const failureMessage = retirementFailure
          ? expect.stringContaining(closeError)
          : "health check threw: synthetic authoritative detector failure";
        expect(report.findings).toEqual(
          retirementFailure || detectorFailure
            ? [
                expect.objectContaining({
                  checkId,
                  severity: "error",
                  message: failureMessage,
                }),
              ]
            : [],
        );
      }
      expect(privateWriter).toBeDefined();
      const snapshotRoot = path.dirname(
        resolveOpenClawStateDirForDatabasePath(privateWriter!.path),
      );
      if (retirementFailure) {
        // Full reports can retire a separate read-only snapshot. No attempted
        // removal may touch this failed snapshot, its children, or an ancestor.
        const removedPrivatePaths = removal.mock.calls
          .map(([target]) => path.resolve(String(target)))
          .filter(
            (target) =>
              target === snapshotRoot ||
              target.startsWith(`${snapshotRoot}${path.sep}`) ||
              snapshotRoot.startsWith(`${target}${path.sep}`),
          );
        expect(removedPrivatePaths).toEqual([]);
      }
      if (nativeWindows) {
        expect(nativeOpenHandleRefused).toBe(true);
        expect(nativeRemovalErrors).toMatchObject(
          cleanupFailure ? [{ code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/) }] : [],
        );
        if (cleanupFailure) {
          expect(nativeCleanupBlocker?.isOpen).toBe(true);
          expect(fs.existsSync(nativeCleanupBlockerPath!)).toBe(true);
        }
      }
      expect(report.warnings ?? []).toMatchObject(
        cleanupFailure ? [{ requirement: "temporary-snapshot-cleanup", severity: "warning" }] : [],
      );
      expect(privateAuth?.isOpen).toBe(readerRetirementFailure);
      if (readerRetirementFailure) {
        expect(privateWriter?.db.isOpen).toBe(false);
        expect(privateReader?.database.db.isOpen).toBe(false);
      }
      if (!retirementFailure) {
        expect(privateWriter?.db.isOpen).toBe(false);
        expect(privateReader?.database.db.isOpen).toBe(false);
      }
      // Recursive removal can partially succeed before a genuine Windows denial.
      expect(fs.existsSync(snapshotRoot)).toBe(retirementFailure || cleanupFailure);
      if (!nativeWindows || !cleanupFailure) {
        expect(fs.existsSync(privateWriter!.path)).toBe(retirementFailure || cleanupFailure);
      }
      expect(removedSnapshot).toBe(!retirementFailure && !cleanupFailure);
      expect([source.db.isOpen, callerReader.isOpen]).toEqual([true, true]);
      const callerRow = callerReader.prepare("SELECT value FROM fixture").get();
      expect(callerRow).toEqual({ value: "unchanged" });
      expect(fs.readFileSync(callerPath)).toEqual(callerBefore);
      expect(snapshotDoctorLintSqliteFamily(source.path)).toEqual(before);
      expect(readConfigMachineState("doctorLint.synthetic.privateWrite")).toBeUndefined();
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(process.env.OPENCLAW_CONFIG_PATH).toBe(sourceConfigPath);
    } finally {
      stdout.mockRestore();
      removal.mockRestore();
      restoreAuthClose?.();
      sqliteOpen.mockReset();
      nativeCleanupBlocker?.close();
      privateReader?.close();
      if (privateWriter) {
        const rootPath = resolveOpenClawStateDirForDatabasePath(privateWriter.path);
        closeAuthProfileReadPool({ kind: "root", rootPath });
        await closeOpenClawStateDatabaseByPathAsync(privateWriter.path);
        // Retained snapshots still own native staging tokens after injected failures.
        expect(await removeTempDirectoryAsync(path.dirname(rootPath))).toBe(true);
      }
      unregister?.();
      closeAuthProfileReadPool({ kind: "root", rootPath: state.root });
    }
  });
}
