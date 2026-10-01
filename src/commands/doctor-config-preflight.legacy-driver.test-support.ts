import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { disableUpdatedPackageCompileCacheEnv } from "../cli/update-cli/update-command-service-env.js";
import {
  createUpdatePostInstallDoctorResultPath,
  consumeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

type LegacyDriverMode =
  | "valid"
  | "valid managed v1"
  | "valid managed pnpm"
  | "managed pnpm missing metadata"
  | "managed pnpm partial metadata"
  | "managed pnpm missing metadata run"
  | "managed handoff mismatch"
  | "managed handoff missing"
  | "failed schema publication"
  | "terminal post-core run"
  | "missing post-core run";

export function registerLegacyDriverTests(modes: readonly LegacyDriverMode[]) {
  const tempDirs = createFixtureLifetime();
  afterAll(() => tempDirs.cleanup());
  const DOCTOR_CHILD_TIMEOUT_MS = 60_000;
  let unmanagedRollbackRuntimeRoot: string | undefined;

  function createRollbackRuntime(root: string): string {
    // Rehearsal clears environment overrides, so this core-only fixture owns an empty plugin tree.
    return createBuiltRuntime(root, undefined, { copyDirectories: true, emptyExtensions: true });
  }

  it.each(modes)(
    "keeps the shipped 9.2 rollback window read-only and validates private state: %s",
    async (mode) => {
      await withOpenClawTestState(
        {
          scenario: "minimal",
          env: {
            // Published 2026.9.2 update-command-package.ts sets these, including DEFER=1.
            ...buildUpdateDoctorEnv({
              allowGatewayServiceRepair: false,
              allowGatewayActivation: false,
              deferConfiguredPluginInstallRepair: true,
              serviceRepairPolicy: "external",
              compatibilityHostVersion: VERSION,
            }),
            OPENCLAW_UPDATE_POST_CORE: undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async (state) => {
          await state.writeConfig({
            plugins: { enabled: false },
            agents: {
              ownership: "explicit",
              entries: { main: { workspace: state.workspaceDir } },
            },
            gateway: { mode: "local", auth: { mode: "none" } },
          });
          const agentPath = openOpenClawAgentDatabase({ agentId: "main" }).path;
          const sharedPath = openOpenClawStateDatabase().path;
          const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
          recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "in_progress" });
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
          const legacy = new DatabaseSync(agentPath);
          try {
            restoreEmptyV21StorageForHistoricalFixture(legacy);
            removeCanonicalValidationFromHistoricalAgentFixture(legacy);
            legacy.exec(`DROP TABLE session_transcript_cold_archives;
          PRAGMA user_version = 19;
          UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
          INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
            VALUES ('upgrade-proof','retained','{"keep":true}',NULL,7);
          INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
            VALUES ('agent:main:history','window-1','{"sessionId":"window-1","updatedAt":20}',20);
          INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
            VALUES ('window-1','agent:main:history',10,20);
          INSERT INTO transcript_events (session_id,seq,event_json,created_at)
            VALUES ('window-1',7,'{ "type": "message", "text": "retained bytes 雪" }',11);`);
            if (mode === "failed schema publication") {
              legacy.exec(`CREATE TRIGGER reject_schema_publication BEFORE UPDATE ON schema_meta
              WHEN NEW.schema_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}
              BEGIN SELECT RAISE(ABORT, 'fixture schema publication failure'); END;`);
            }
          } finally {
            legacy.close();
          }
          const originals = [agentPath, sharedPath, state.configPath];
          const bytes = originals.map((file) => fs.readFileSync(file));
          const malformedHandoff = mode.startsWith("managed pnpm ");
          const managed =
            mode === "valid managed v1" ||
            mode === "valid managed pnpm" ||
            malformedHandoff ||
            mode === "managed handoff mismatch" ||
            mode === "managed handoff missing";
          const relocatesRuntime = mode === "valid managed pnpm" || malformedHandoff;
          // Managed handoff authority includes the install path, so keep those packages private.
          let runtimeRoot = managed
            ? createRollbackRuntime(state.root)
            : (unmanagedRollbackRuntimeRoot ??= createRollbackRuntime(
                fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-rollback-runtime-")),
              ));
          let managedRoot = runtimeRoot;
          if (relocatesRuntime) {
            const project = state.path("pnpm", "global", "5");
            const previous = path.join(
              project,
              ".pnpm",
              "openclaw@2026.9.2",
              "node_modules",
              "openclaw",
            );
            const current = path.join(
              project,
              ".pnpm",
              `openclaw@${VERSION}`,
              "node_modules",
              "openclaw",
            );
            fs.mkdirSync(path.dirname(current), { recursive: true });
            fs.renameSync(runtimeRoot, current);
            runtimeRoot = fs.realpathSync(current);
            fs.mkdirSync(previous, { recursive: true });
            fs.writeFileSync(
              path.join(previous, "package.json"),
              JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
            );
            fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
            fs.writeFileSync(
              path.join(project, "node_modules", ".modules.yaml"),
              "layoutVersion: 5\n",
            );
            fs.writeFileSync(
              path.join(project, "package.json"),
              JSON.stringify({ dependencies: { openclaw: VERSION } }),
            );
            fs.symlinkSync(
              current,
              path.join(project, "node_modules", "openclaw"),
              process.platform === "win32" ? "junction" : "dir",
            );
            managedRoot = fs.realpathSync(previous);
          }
          // Rehearsal preserves these exact bytes. Exercise both package layouts once;
          // the remaining variants differ only at the post-core boundary below.
          if (
            mode === "valid" ||
            mode === "valid managed pnpm" ||
            mode === "failed schema publication"
          ) {
            const resultPath = createUpdatePostInstallDoctorResultPath();
            // The shipped updater disables compile caching before both child handoffs.
            const result = await runBuiltRuntime(
              runtimeRoot,
              disableUpdatedPackageCompileCacheEnv({
                ...process.env,
                OPENCLAW_DEBUG_PROXY_ENABLED: "1",
                [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath,
                NODE_ENV: undefined,
                VITEST: undefined,
                VITEST_POOL_ID: undefined,
                VITEST_WORKER_ID: undefined,
              }),
              ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
              DOCTOR_CHILD_TIMEOUT_MS,
            );
            const output = `${result.stdout}\n${result.stderr}`;
            const receipt = await consumeUpdatePostInstallDoctorResult(resultPath);
            expect(result.signal, output).toBeNull();
            expect(
              originals.map((file) => fs.readFileSync(file)),
              output,
            ).toEqual(bytes);
            if (mode === "failed schema publication") {
              expect(result.code, output).toBe(1);
              expect(output).toContain("Private Doctor schema validation failed");
              expect(output).toContain("Failing check media-persistence (step-refused)");
              expect(output).not.toContain("Repair is deferred");
              return;
            }
            expect(result.code, output).toBe(0);
            expect(receipt).toMatchObject({
              status: "ok",
              configHash: "unchanged",
              warnings: [expect.stringContaining("live agent databases are unchanged")],
            });
            expect(output).toContain("live agent databases are unchanged");
            expect(output).not.toContain("Doctor complete.");
          }
          // The published driver has now discarded package rollback and recorded its
          // fresh post-core boundary. Only the native child can carry live authority.
          recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
          recordUpdateRunStep(run.runId, {
            step: "post-update verification",
            status: "in_progress",
          });
          if (mode === "terminal post-core run") {
            finishUpdateRun(run.runId, { status: "failed", reason: "fixture-parent-stopped" });
          }
          const beforeResume = getUpdateRun(run.runId);
          const success =
            mode === "valid" || mode === "valid managed v1" || mode === "valid managed pnpm";
          const metaPath = state.path("handoff-meta.json");
          let managedRow: { owner: string; payload_json: string; updated_at: number } | undefined;
          if (managed) {
            const store = createManagedHandoffLeaseStore();
            const initialized = store.acquire(managedRoot, run.runId, { kind: "update" });
            if (initialized.kind !== "acquired" || !store.release(initialized.lease)) {
              throw new Error("Could not initialize isolated fixture handoff");
            }
            const { pid, startIdentity } = store.processIdentity();
            managedRow = {
              owner: "shipped-owner",
              payload_json: JSON.stringify({ version: 1, pid, startIdentity }),
              updated_at: 7,
            };
            const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
            try {
              db.prepare(
                "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
              ).run(managedRoot, managedRow.owner, managedRow.payload_json, managedRow.updated_at);
            } finally {
              db.close();
            }
            if (mode !== "managed pnpm missing metadata") {
              fs.writeFileSync(
                metaPath,
                JSON.stringify({
                  version: 1,
                  meta: {
                    runId: mode === "managed pnpm missing metadata run" ? undefined : run.runId,
                    root: mode === "managed pnpm partial metadata" ? undefined : managedRoot,
                    handoffId:
                      mode === "managed handoff mismatch" ? "another-owner" : managedRow.owner,
                  },
                }),
              );
            }
          }
          if (mode === "managed handoff missing") {
            const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
            db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(
              managedRoot,
            );
            db.close();
          }
          const resume = () =>
            runBuiltRuntime(
              runtimeRoot,
              disableUpdatedPackageCompileCacheEnv({
                ...process.env,
                OPENCLAW_UPDATE_POST_CORE: "1",
                OPENCLAW_UPDATE_RUN_HANDOFF: managed ? "1" : undefined,
                ...(managed ? { OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: metaPath } : {}),
                OPENCLAW_UPDATE_RUN_ID:
                  mode === "missing post-core run"
                    ? "53e56de0-a951-4b3d-af1a-9e4f1ac5a069"
                    : run.runId,
                OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
                OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: state.path("post-core-result.json"),
                OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now()),
                NODE_ENV: undefined,
                VITEST: undefined,
                VITEST_POOL_ID: undefined,
                VITEST_WORKER_ID: undefined,
              }),
              ["update", "--json", "--yes", "--no-restart"],
              DOCTOR_CHILD_TIMEOUT_MS,
            );
          const resumed = await resume();
          if (mode === "valid managed v1" && resumed.code === 0) {
            const current = new DatabaseSync(agentPath, { readOnly: true });
            try {
              expect(current.prepare("PRAGMA user_version").get()?.user_version).toBe(
                OPENCLAW_AGENT_SCHEMA_VERSION,
              );
            } finally {
              current.close();
            }
            // A current-schema continuation must retain the same live parent
            // without requiring another migration or a new update-history row.
            const sameSchema = await resume();
            expect(sameSchema.code, `${sameSchema.stdout}\n${sameSchema.stderr}`).toBe(0);
          }
          if (managedRow) {
            const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
            try {
              expect(
                db
                  .prepare(
                    "SELECT owner,payload_json,updated_at FROM managed_update_handoffs WHERE install_root = ?",
                  )
                  .get(managedRoot),
              ).toEqual(mode === "managed handoff missing" ? undefined : managedRow);
              if (managedRoot !== runtimeRoot) {
                expect(
                  db
                    .prepare(
                      "SELECT COUNT(*) AS count FROM managed_update_handoffs WHERE instr(install_root, ?) = 1",
                    )
                    .get(runtimeRoot)?.count,
                ).toBe(0);
              }
              expect(
                db
                  .prepare(
                    "SELECT COUNT(*) AS count FROM managed_update_handoffs WHERE instr(install_root, ?) = 1",
                  )
                  .get(`${managedRoot}/.openclaw-update-child-`)?.count,
              ).toBe(0);
            } finally {
              db.prepare(
                "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
              ).run(managedRoot, managedRow.owner);
              db.close();
            }
          }
          expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(success ? 0 : 1);
          expect(listUpdateRuns({ limit: 100 }).map((entry) => entry.runId)).toEqual([run.runId]);
          expect(getUpdateRun(run.runId)).toMatchObject({
            status: beforeResume?.status,
            before: beforeResume?.before,
            origin: beforeResume?.origin,
            phase: beforeResume?.phase,
          });
          if (!success) {
            if (malformedHandoff) {
              expect(`${resumed.stdout}\n${resumed.stderr}`).toContain(
                "Legacy managed post-core handoff is incomplete or names another update run.",
              );
            }
            expect(fs.readFileSync(agentPath)).toEqual(bytes[0]);
            return;
          }
          const repaired = new DatabaseSync(agentPath, { readOnly: true });
          try {
            expect(repaired.prepare("PRAGMA user_version").get()?.user_version).toBe(
              OPENCLAW_AGENT_SCHEMA_VERSION,
            );
            expect(
              repaired.prepare("SELECT value_json,updated_at FROM cache_entries").all(),
            ).toEqual([{ value_json: '{"keep":true}', updated_at: 7 }]);
            expect(repaired.prepare("SELECT event_json,seq FROM transcript_events").all()).toEqual([
              { event_json: '{ "type": "message", "text": "retained bytes 雪" }', seq: 7 },
            ]);
          } finally {
            repaired.close();
          }
        },
      );
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS, DOCTOR_CHILD_TIMEOUT_MS),
  );
}
