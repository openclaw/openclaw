import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import {
  preparation,
  original,
  stateV21Schema,
  seedHistoricalPlacements,
} from "../state/openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const childTimeout = 90_000;

it(
  "doctor discovers historical shared-v21 and agent-v24 stores and preserves their import payloads",
  async () => {
    const port = await acquireTestPortBlock({ offsets: [0] });
    onTestFinished(port.release);
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        gateway: { mode: "local", port: port.port, controlUi: { enabled: false } },
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      let originalPlacements: Record<string, SQLOutputValue>[];
      {
        using db = new DatabaseSync(sharedPath);
        db.exec(stateV21Schema());
        db.exec(
          "PRAGMA user_version=21; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',21,1,1);",
        );
        db.prepare(
          "INSERT INTO worker_environments " +
            "(environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id," +
            "state,owner_epoch,attached_session_ids_json,created_at_ms,updated_at_ms,state_changed_at_ms) " +
            "VALUES ('historical-image','synthetic','sandbox',?,'provision-image','destroyed',7,'[]',1,2,2)",
        ).run(original);
        originalPlacements = seedHistoricalPlacements(db);
      }
      const agentPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      let originalInputs: Record<string, SQLOutputValue>[];
      let expectedInputs: Record<string, SQLOutputValue>[];
      {
        using db = new DatabaseSync(agentPath);
        db.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
        db.exec(
          "ALTER TABLE session_pending_inputs ADD COLUMN recovery_intent_json TEXT; PRAGMA user_version=24;" +
            "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES ('primary','agent',24,'main',1,1);" +
            "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES ('agent:main:history','sid-1','{\"sessionId\":\"sid-1\",\"updatedAt\":1}',1);" +
            "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES ('sid-1','agent:main:history',1,1);",
        );
        for (const status of ["queued", "interrupted", "cancelled"]) {
          db.prepare(
            "INSERT INTO session_pending_inputs " +
              "(input_id,session_key,session_id,idempotency_key,run_id,request_hash,message_json,lifecycle_generation,state,accepted_at,recovery_intent_json) " +
              "VALUES (?, 'agent:main:history','sid-1',?,?,'hash',?,'historical-generation',?,1,?)",
          ).run(
            status,
            status,
            "run-" + status,
            JSON.stringify({ role: "user", content: "Retain " + status }),
            status,
            '{"historical":"evidence-only"}',
          );
        }
        originalInputs = db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all();
        expectedInputs = structuredClone(originalInputs);
        for (const row of expectedInputs) {
          if (row.state === "queued") {
            row.state = "interrupted";
          }
          row.consumed_event_id = null;
        }
      }
      const runtime = createSourceRuntime(state.root);
      const env: NodeJS.ProcessEnv = {
        ...state.env,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_NO_RESPAWN: "1",
        NO_COLOR: "1",
      };
      for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
        delete env[key];
      }
      {
        const result = await runSourceRuntime(
          runtime,
          env,
          [
            "--input-type=module",
            "--eval",
            [
              'import { registerHooks } from "node:module";',
              'import path from "node:path";',
              "registerHooks({ resolve(specifier, context, nextResolve) {",
              'if (specifier.endsWith("/doctor-health-contributions.js")) {',
              'return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(',
              '"export async function runDoctorHealthContributions() {}\\n" +',
              '"export async function resolveDoctorContributionHealthChecks() { return []; }") };',
              "}",
              "return nextResolve(specifier, context);",
              "}});",
              'process.argv = [process.execPath,path.resolve("src/entry.ts"),"doctor","--fix","--non-interactive","--no-workspace-suggestions"];',
              'await import("./src/entry.ts");',
            ].join("\n"),
          ],
          childTimeout,
        );
        const output = result.stdout + "\n" + result.stderr;
        expect(result.code, output).toBe(0);
        expect(output).toContain("Doctor complete.");
        for (const [pathname, version] of [
          [sharedPath, OPENCLAW_STATE_SCHEMA_VERSION],
          [agentPath, OPENCLAW_AGENT_SCHEMA_VERSION],
        ] as const) {
          using database = new DatabaseSync(pathname, { readOnly: true });
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
          expect(
            database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
          ).toBe(version);
        }
        using db = new DatabaseSync(sharedPath, { readOnly: true });
        const environment = db
          .prepare("SELECT profile_snapshot_json FROM worker_environments")
          .get()!;
        expect(JSON.parse(String(environment.profile_snapshot_json))).toMatchObject({
          runtimePreparation: { source: "empty", key: preparation.key },
          historicalProfileSnapshotJson: original,
        });
        expect(
          db
            .prepare(
              "SELECT state FROM worker_session_placements WHERE session_id='placement-pending'",
            )
            .get(),
        ).toEqual({ state: "failed" });
        using agent = new DatabaseSync(agentPath, { readOnly: true });
        expect(agent.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
          expectedInputs,
        );
        agent.close();
        db.close();
        // The CLI has exited and all local readers are closed before restoring its real backups.
        for (const [pathname, version] of [
          [sharedPath, 21],
          [agentPath, 24],
        ] as const) {
          const directory = path.dirname(pathname);
          const backup = fs.readdirSync(directory).find((name) => {
            if (
              !name.startsWith(path.basename(pathname) + ".pre-startup-migration-") ||
              !name.endsWith(".bak") ||
              name.endsWith(".scoped.bak")
            ) {
              return false;
            }
            using archived = new DatabaseSync(path.join(directory, name), { readOnly: true });
            return archived.prepare("PRAGMA user_version").get()?.user_version === version;
          });
          expect(backup).toBeDefined();
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            fs.rmSync(pathname + suffix, { force: true });
          }
          fs.copyFileSync(path.join(directory, backup!), pathname);
          using restored = new DatabaseSync(pathname, { readOnly: true });
          expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
          expect(
            restored.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
          ).toBe(version);
        }
        using restoredAgent = new DatabaseSync(agentPath, { readOnly: true });
        expect(
          restoredAgent.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all(),
        ).toEqual(originalInputs);
        using restoredShared = new DatabaseSync(sharedPath, { readOnly: true });
        expect(
          restoredShared
            .prepare("SELECT * FROM worker_session_placements ORDER BY session_id")
            .all(),
        ).toEqual(originalPlacements);
        expect(
          restoredShared.prepare("SELECT profile_snapshot_json FROM worker_environments").get(),
        ).toEqual({ profile_snapshot_json: original });
      }
    });
  },
  getCliProcessTestTimeout(childTimeout),
);
