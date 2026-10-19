import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { parseUpdateRecoveryBackupManifest } from "../../commands/backup-verify-manifest.js";
import * as nodeRuntimeDiagnostics from "../../commands/node-runtime-diagnostics.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import * as shared from "./shared.js";
import { updateStatusCommand } from "./status.js";
import * as execution from "./update-command-execution.js";
import type { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as initialization from "./update-command-initialization.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import * as commandTriage from "./update-command-triage.js";
import { updateCommand } from "./update-command.js";

export function createSelectedTargetStateDatabase(databasePath: string) {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(databasePath);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
  } finally {
    db.close();
  }
}

function expectOriginalCapture(params: {
  runId: string;
  manifestPath: string;
  installRoot: string;
  databasePath: string;
  previousRunId?: string;
}) {
  const manifest = parseUpdateRecoveryBackupManifest(fs.readFileSync(params.manifestPath, "utf8"));
  expect(manifest.runId).toBe(params.runId);
  expect(manifest.installRoot).toBe(fs.realpathSync(params.installRoot));
  expect(manifest.generation).toEqual({ kind: "baseline" });
  const databasePath = fs.realpathSync(params.databasePath);
  expect(manifest.databases).toContainEqual({ role: "global", path: databasePath });
  const captured = manifest.entries.find((entry) => entry.sourcePath === databasePath);
  if (params.previousRunId !== undefined) {
    assert(captured?.kind === "file");
    expect(captured.sqlite).toBe(true);
    const original = new DatabaseSync(
      path.join(path.dirname(params.manifestPath), captured.archivePath),
      { readOnly: true },
    );
    try {
      expect(
        original
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("fixture.original"),
      ).toEqual({ value_json: '{"message":"acknowledged before update"}' });
      expect(original.prepare("SELECT run_id FROM update_runs ORDER BY run_id").all()).toEqual([
        { run_id: params.previousRunId },
      ]);
    } finally {
      original.close();
    }
  } else {
    expect(captured).toEqual({
      kind: "missing",
      sourcePath: databasePath,
      sqlite: true,
      directory: false,
    });
  }
}

export function allowPackageRuntime() {
  return vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: {},
  });
}

export function createStage(root: string) {
  return { root, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
}

export function registerOriginalCaptureTests({
  fixture,
  dirs,
}: ReturnType<typeof installFreshUpdateFixture>) {
  it.each([
    { schema: OPENCLAW_STATE_SCHEMA_VERSION, existing: false, refused: false },
    { schema: OPENCLAW_STATE_SCHEMA_VERSION + 1, existing: false, refused: false },
    { schema: OPENCLAW_STATE_SCHEMA_VERSION, existing: true, refused: false },
    { schema: OPENCLAW_STATE_SCHEMA_VERSION, existing: true, refused: true },
    {
      schema: OPENCLAW_STATE_SCHEMA_VERSION,
      existing: true,
      refused: true,
      releaseDenied: true,
    },
  ])(
    "captures original state before parent history (schema=$schema, existing=$existing, refused=$refused, release denied=$releaseDenied)",
    async ({ schema, existing, refused, releaseDenied = false }) => {
      const previousRunId = existing ? createUpdateRun({ trigger: "cli" }).runId : undefined;
      if (previousRunId) {
        finishUpdateRun(previousRunId, { status: "succeeded" });
        await closeOpenClawStateDatabaseAsync();
        const original = new DatabaseSync(fixture.databasePath);
        try {
          original
            .prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            )
            .run("fixture.original", '{"message":"acknowledged before update"}', 1);
        } finally {
          original.close();
        }
      }
      const captureRoot = refused ? dirs.make("managed-refused-update-") : fixture.root;
      if (refused) {
        fs.mkdirSync(path.join(captureRoot, "dist"));
        fs.writeFileSync(
          path.join(captureRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
        );
        const serviceUnitTarget = path.join(captureRoot, "dist", "index.js");
        fs.writeFileSync(serviceUnitTarget, "");
        const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation();
        assert(prepare);
        vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (opts) => ({
          ...(await prepare(opts)),
          servicePlan: {
            rootRedirect: { root: captureRoot, previousRoot: fixture.root },
            nodeRunner: process.execPath,
            serviceUnitTarget,
          },
        }));
      }
      let admittedRun: shared.UpdateCommandOptions["run"];
      let admittedRecord: ReturnType<typeof getUpdateRun> | undefined;
      if (releaseDenied) {
        const prepareTriage = commandTriage.prepareUpdateCommandFailureTriage;
        vi.spyOn(commandTriage, "prepareUpdateCommandFailureTriage").mockImplementation(
          async (...args) => {
            const handleFailure = await prepareTriage(...args);
            admittedRun = args[0].run;
            assert(admittedRun);
            admittedRecord = getUpdateRun(admittedRun.runId, { env: admittedRun.env });
            expect(admittedRecord).toMatchObject({ status: "running", finishedAtMs: null });
            expect(admittedRecord?.phase).not.toBe("finished");
            const db = new DatabaseSync(
              path.join(
                tempRoot.resolvePreferredOpenClawTmpDir(),
                "managed-update-handoffs.sqlite",
              ),
            );
            try {
              db.exec(
                "CREATE TRIGGER deny_refusal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
              );
            } finally {
              db.close();
            }
            return handleFailure;
          },
        );
      }
      const candidate = dirs.make("artifact-forward-");
      fs.writeFileSync(
        path.join(candidate, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.9.4",
          engines: { node: ">=22" },
          openclaw: { schemaVersions: { state: schema, agent: 19 } },
        }),
      );
      vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: null });
      const stage = createStage(candidate);
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
      allowPackageRuntime();
      const doctor = vi
        .spyOn(initialization, "initializeUpdateStateFromTarget")
        .mockImplementation(async () => {
          openOpenClawStateDatabase();
          closeOpenClawStateDatabaseForTest();
          const db = new DatabaseSync(fixture.databasePath);
          try {
            db.exec(
              `PRAGMA user_version=${schema}; UPDATE schema_meta SET schema_version=${schema}`,
            );
          } finally {
            db.close();
          }
        });
      const execute = vi
        .spyOn(execution, "executeMutableUpdate")
        .mockImplementation(async (params) => {
          const run = params.opts.run;
          assert(run);
          const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
          try {
            expect(db.prepare("PRAGMA user_version").get()).toEqual({
              user_version: OPENCLAW_STATE_SCHEMA_VERSION,
            });
          } finally {
            db.close();
          }
          expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
          const ref = run.originalRecoveryCapture;
          assert(ref);
          expectOriginalCapture({
            runId: run.runId,
            manifestPath: ref.manifestPath,
            installRoot: captureRoot,
            databasePath: fixture.databasePath,
            previousRunId,
          });
          finishUpdateRun(
            run.runId,
            { status: "skipped", reason: "fixture-before-forward-migration" },
            { env: run.env },
          );
          return null;
        });
      const update = updateCommand({
        tag: refused ? "main" : "file:/fixture/forward.tgz",
        yes: true,
        json: true,
        restart: false,
      });
      if (refused) {
        await expect(update).rejects.toEqual(new ExitError(1));
        expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
        const result = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
        assert(isRecord(result) && typeof result.runId === "string");
        expect(result).toMatchObject({
          status: "error",
          mode: "unknown",
          root: captureRoot,
          reason: releaseDenied ? "update-admission-cleanup-failed" : "unsupported-package-target",
        });
        if (releaseDenied) {
          assert(admittedRun);
          expect(result).toMatchObject({
            runId: admittedRun.runId,
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            failedStep: {
              failureFacts: [expect.objectContaining({ code: "unsupported-package-target" })],
            },
          });
          assert(isRecord(result.failedStep));
          expect(result.failedStep.stderrTail).toContain(
            "`--tag main` cannot update a package install",
          );
          expect(result.failedStep.stderrTail).toContain("fixture final lease delete denied");
          expect(getUpdateRun(admittedRun.runId, { env: admittedRun.env })).toEqual(admittedRecord);
          expect(createManagedHandoffLeaseStore().read(captureRoot)).toMatchObject({
            kind: "current",
          });
        } else {
          expect(getUpdateRun(result.runId)).toMatchObject({ status: "failed" });
        }
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(captureRoot);
        vi.spyOn(nodeRuntimeDiagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
        vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
          root: captureRoot,
          installKind: "package",
          packageManager: "npm",
          registry: { latestVersion: "2026.9.3" },
        });
        await updateStatusCommand({ json: true });
        const output = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
        assert(isRecord(output) && Array.isArray(output.recoverySets));
        const capture = output.recoverySets.find(
          (set) => isRecord(set) && set.runId === result.runId,
        );
        assert(isRecord(capture) && typeof capture.manifestPath === "string");
        expectOriginalCapture({
          runId: result.runId,
          manifestPath: capture.manifestPath,
          installRoot: captureRoot,
          databasePath: fixture.databasePath,
          previousRunId,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
        expect(shared.resolveTargetVersion).not.toHaveBeenCalled();
        expect(stage.close).not.toHaveBeenCalled();
      } else {
        await update;
        expect(execute).toHaveBeenCalledOnce();
        expect(stage.close).toHaveBeenCalledOnce();
      }
      expect(doctor.mock.calls.length).toBe(0);
    },
  );
}
