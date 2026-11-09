import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import * as serviceMaintenance from "../cli/update-cli/update-command-service-maintenance.js";
import { createDoctorMaintenanceState } from "../commands/doctor-maintenance-state.js";
import { defaultRuntime } from "../runtime.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  adoptCandidateManagedServiceStop,
  stopSupervisedPredecessorGateway,
} from "./update-candidate-predecessor-stop.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";
import {
  readUpdateDoctorGeneration,
  runUpdateDoctorAttributedStateWrite,
} from "./update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform !== "win32").each(["none", "before", "after", "other", "ordinary"])(
  "retains the original capture through the real stop ledger and Doctor handoff: %s",
  async (interference) => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: true }, async ({ env }) => {
      const pathname = openOpenClawStateDatabase({ env }).path;
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      await closeOpenClawStateDatabaseAsync();
      const other = path.join(path.dirname(pathname), "companion.sqlite");
      {
        using db = new DatabaseSync(other);
        db.exec("CREATE TABLE retained(value); INSERT INTO retained VALUES (7)");
      }
      const generations = readUpdateDatabaseGenerations([pathname, other]);
      const foreignWrite = (file = pathname) => {
        using db = new DatabaseSync(file);
        db.exec("CREATE TABLE unrelated_write(value)");
      };
      vi.spyOn(serviceMaintenance, "maybeStopManagedServiceBeforeMutableUpdate").mockImplementation(
        async (options) => {
          options.assertCurrent?.();
          if (interference === "before") {
            foreignWrite();
          }
          const stopped = {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: false,
            servicePid: 631,
            serviceManagerUid: 1000,
            stoppedAtMs: 7,
            serviceUpdateVerdict: {
              kind: "owned" as const,
              root: process.cwd(),
              fingerprint: "sealed",
              refreshDefinition: false,
            },
          };
          options.onStopped?.(stopped);
          return stopped;
        },
      );
      const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
        env,
        signal: new AbortController().signal,
        warn: vi.fn(),
      })!;
      await capture.admit(true);
      const preparing = stopSupervisedPredecessorGateway(
        { runId, repair: true },
        {
          root: process.cwd(),
          assertCurrent() {},
          warn: vi.fn(),
          databaseWriteCapture: capture,
        },
      );
      if (interference === "before") {
        await expect(preparing).rejects.toThrow("source changed after update capture");
      } else {
        expect(await preparing).toBe(true);
        if (interference === "after" || interference === "other") {
          foreignWrite(interference === "other" ? other : pathname);
        }
        const repair = vi.fn(async () => {});
        const maintenance = await createDoctorMaintenanceState({
          params: {
            options: { repair: true },
            root: process.cwd(),
            runtime: defaultRuntime,
            databaseWriteCapture: capture,
            beforeStateMutation: repair,
          },
          env,
          signal: new AbortController().signal,
          deadline: () => undefined,
          assertReadCurrent() {},
          settle: (operation) => operation(),
          warn: vi.fn(),
        });
        try {
          if (interference === "after" || interference === "other") {
            await expect(maintenance.acquire()).rejects.toThrow("before Doctor repair handoff");
            expect(repair).not.toHaveBeenCalled();
          } else {
            await maintenance.acquire();
            await maintenance.prepareRepair();
            expect(repair).toHaveBeenCalledOnce();
            if (interference === "ordinary") {
              // A non-opted-in native owner write inside Doctor remains unattributed.
              maintenance.run(() =>
                recordUpdateRunStep(
                  runId,
                  { step: "doctor:ordinary", status: "completed" },
                  { env },
                ),
              );
            }
          }
        } finally {
          await maintenance.release();
        }
        if (interference === "after" || interference === "other") {
          // Failed first admission cannot publish an accepted migration receipt.
          expect(capture.receipt).toBeUndefined();
        } else {
          expect(capture.receipt).toMatchObject({
            unchanged: interference === "none",
            fromGenerations: generations,
          });
        }
      }
      if (interference === "before") {
        await capture.settle();
        expect(capture.receipt).toMatchObject({ unchanged: false, fromGenerations: generations });
      }
      const backup: UpdateDatabaseBackup = {
        directory: path.dirname(pathname),
        databases: [],
        missingPaths: [],
        sourcePaths: Object.keys(generations),
        sourceGenerations: generations,
        warnings: [],
      };
      recordUpdateDatabaseWrites(backup, capture.receipt, { name: "doctor" });
      if (interference === "none") {
        expect(backup.migration?.from).toEqual(generations);
      } else {
        expect(backup.migration).toBeUndefined();
        if (interference === "before" || interference === "ordinary") {
          expect(backup.restoreRefusal).toContain("writer is unknown");
        }
      }
      const receipts = getUpdateRun(runId, { env })?.steps.filter((step) =>
        step.step.startsWith("finalize:predecessor-stop:"),
      );
      expect(receipts).toEqual([
        expect.objectContaining({
          step: "finalize:predecessor-stop:7:1000:631:sealed",
          status: "completed",
        }),
      ]);
      if (interference === "none") {
        const inspect = vi.mocked(serviceMaintenance.maybeStopManagedServiceBeforeMutableUpdate);
        const state = {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: false,
          serviceManagerUid: 1000,
          serviceUpdateVerdict: {
            kind: "owned" as const,
            root: process.cwd(),
            fingerprint: "sealed",
            refreshDefinition: false,
          },
        };
        const adopt = () =>
          adoptCandidateManagedServiceStop({
            transferred: undefined,
            shouldRestart: false,
            mode: "npm",
            status: "ok",
            runId,
            ledger: { env },
            root: process.cwd(),
            assertCurrent() {},
            onStep: vi.fn(),
          });
        inspect.mockResolvedValue(state);
        expect(await adopt()).toMatchObject({ stopped: { stopped: true }, restartRequired: true });
        inspect.mockResolvedValue({
          ...state,
          serviceUpdateVerdict: { ...state.serviceUpdateVerdict, fingerprint: "replacement" },
        });
        expect(await adopt()).toEqual({ stopped: undefined, restartRequired: false });
        inspect.mockResolvedValue({ ...state, running: true });
        expect(await adopt()).toMatchObject({ restartRequired: false });
        inspect.mockRejectedValue(new Error("inspection unavailable"));
        await expect(adopt()).rejects.toThrow("recovery remains pending");
      }
      await closeOpenClawStateDatabaseAsync();
    });
  },
);

it
  .runIf(process.platform !== "win32")
  .each([
    "reader",
    "last-close",
    "foreign",
    "reverted",
    "replacement",
    "authority",
    "missing-key",
    "alias",
    "ambiguous",
    "close",
  ])(
  "one-shot attribution preserves empty-reader equivalence without blessing %s changes",
  async (transition) => {
    const root = directories.make("receipt-attribution-");
    const pathname = path.join(root, "source.sqlite");
    {
      using db = new DatabaseSync(pathname);
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE retained(value); INSERT INTO retained VALUES(7)",
      );
    }
    const reader = transition === "last-close" ? new DatabaseSync(pathname) : undefined;
    reader?.prepare("SELECT * FROM retained").all();
    const aliasRoot = path.join(root, "alias");
    if (transition === "alias" || transition === "ambiguous") {
      fs.symlinkSync(root, aliasRoot, "dir");
    }
    const alias = path.join(aliasRoot, "source.sqlite");
    const capturedPaths =
      transition === "alias"
        ? [alias]
        : transition === "ambiguous"
          ? [pathname, alias]
          : [pathname];
    const generations = readUpdateDatabaseGenerations(capturedPaths);
    let current = true;
    const capture = createUpdateDoctorDatabaseWriteCapture(
      transition === "missing-key" ? {} : generations,
      {
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        signal: new AbortController().signal,
        assertCurrent() {
          if (!current) {
            throw new Error("authority lost");
          }
        },
        warn: vi.fn(),
      },
    )!;
    await capture.admit(true);
    reader?.close();
    if (transition === "reader") {
      using db = new DatabaseSync(pathname, { readOnly: true });
      db.prepare("SELECT * FROM retained").all();
    }
    if (transition === "replacement") {
      fs.renameSync(pathname, pathname + ".old");
      fs.copyFileSync(pathname + ".old", pathname);
    }
    const writer =
      transition === "foreign" || transition === "reverted"
        ? new DatabaseSync(pathname)
        : undefined;
    writer?.exec("UPDATE retained SET value=8");
    if (transition === "reverted") {
      writer!.exec("UPDATE retained SET value=7");
    }
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess() {},
    });
    const db = new DatabaseSync(pathname);
    const operation = vi.fn(() => {
      if (transition === "reader") {
        const peer = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout=0; INSERT INTO retained VALUES(99)");',
            pathname,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        expect(peer.status).not.toBe(0);
        expect(peer.stderr).toMatch(/locked/iu);
      }
      db.exec("INSERT INTO retained VALUES(9)");
    });
    if (transition === "authority") {
      current = false;
    }
    try {
      const write = () =>
        scope.run(() =>
          capture.run(() =>
            runUpdateDoctorAttributedStateWrite(db, pathname, operation, () => {
              if (transition === "close") {
                throw new Error("synthetic close failure");
              }
              db.close();
            }),
          ),
        );
      if (transition === "reader" || transition === "last-close" || transition === "alias") {
        write();
        expect(operation).toHaveBeenCalledOnce();
      } else {
        expect(write).toThrow();
        if (transition === "close") {
          expect(operation).toHaveBeenCalledOnce();
        } else {
          expect(operation).not.toHaveBeenCalled();
        }
      }
    } finally {
      if (db.isOpen) {
        db.close();
      }
      writer?.close();
      current = true;
      await scope.close();
    }
    await capture.settle();
    expect(capture.receipt?.fromGenerations).toEqual(
      transition === "missing-key" ? {} : generations,
    );
    expect(capture.receipt?.unchanged).toBe(
      transition === "reader" || transition === "last-close" || transition === "alias",
    );
    if (fs.existsSync(aliasRoot)) {
      fs.unlinkSync(aliasRoot);
    }
    expect(readUpdateDoctorGeneration(pathname).generation).toMatch(/^[a-f0-9]{64}$/u);
  },
);
