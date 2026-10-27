import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { migrateDaemonRuntimePins } from "../../infra/state-migrations.daemon-runtime-pins.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { readUpdateDatabaseGenerations } from "../../infra/update-database-generations.js";
import { runUpdateSqliteMigration } from "../../infra/update-doctor-migration-attribution.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../../infra/update-doctor-result.js";
import { completeAgentDeletionJournalInDatabase } from "../../state/agent-deletion-journal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";

// The retained updater reads through the real candidate's newer schema contract.
vi.mock("../../state/openclaw-schema-versions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-schema-versions.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

const currentSchemas = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
const runtimeFixture = createFixtureLifetime();
let candidateRoot: string;
beforeAll(async () => {
  const runtime = await runtimeFixture.run(() =>
    prepareCandidateAuthorityRuntime(runtimeFixture.createTempDir("schema-candidate-runtime-")),
  );
  candidateRoot = fileURLToPath(new URL("../../", runtime.worker));
});
afterAll(() => runtimeFixture.cleanup());
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
});

async function fixture(prefix: string) {
  const stateDir = await fs.realpath(dirs.make(prefix));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    stateDir,
    env,
    shared: openOpenClawStateDatabase({ env }),
    result: updateResult({ root: candidateRoot, durationMs: 0 }),
  };
}

function inspect(
  params: Omit<Parameters<typeof inspectActivatedUpdateState>[0], "root" | "config"> & {
    config?: Parameters<typeof inspectActivatedUpdateState>[0]["config"];
  },
) {
  return runtimeFixture.track(
    inspectActivatedUpdateState({
      root: candidateRoot,
      config: {},
      candidateSchemaVersions: currentSchemas,
      ...params,
    }),
  );
}

function setSchema(file: string, version: number) {
  using db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${version}`);
}

it.each([
  { agentId: "main", changed: "none", blocked: undefined },
  { agentId: "verification", changed: "none", blocked: undefined },
  { agentId: "main", changed: "local", blocked: undefined },
  { agentId: "main", changed: "client", blocked: undefined },
  { agentId: "main", changed: "shared", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "agent", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "incomplete", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "retained", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "pending", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "content-after", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "content-before", blocked: undefined },
  { agentId: "main", changed: "content-published", blocked: undefined },
])(
  "classifies activation after first-use database creation (agent=$agentId, changed=$changed)",
  async ({ agentId, changed, blocked }) => {
    const { stateDir, env, shared, result } = await fixture("update-first-serving-turn-");
    const contentVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const contentChange = changed.startsWith("content-");
    const markContentApplied = () =>
      shared.db
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("state.schema.contentVersion", JSON.stringify(contentVersion), Date.now());
    if (changed === "content-before" || changed === "content-published") {
      markContentApplied();
    }
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    if (contentChange) {
      markContentApplied();
    }
    if (changed === "local") {
      expect((await migrateDaemonRuntimePins(env)).warnings).toEqual([]);
    }
    if (changed === "client") {
      const pathname = path.join(stateDir, "client", "credentials.sqlite");
      await fs.mkdir(path.dirname(pathname), { recursive: true });
      using db = new DatabaseSync(pathname);
      db.exec("PRAGMA user_version = 1; CREATE TABLE synthetic_credentials(value TEXT)");
    }
    const agentPath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");

    runOpenClawAgentWriteTransaction(() => {}, { agentId, env });
    closeOpenClawAgentDatabasesForTest();
    let retainedPath: string | undefined;
    let retainedBytes: Buffer | undefined;
    if (changed === "retained" || changed === "pending") {
      const agentDir = path.join(stateDir, "agents", "retired", "agent");
      retainedPath = path.join(agentDir, "openclaw-agent.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      setSchema(retainedPath, OPENCLAW_AGENT_SCHEMA_VERSION - 1);
      retainedBytes = await fs.readFile(retainedPath);
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId: "delete-retired",
          agentDir,
          workspaceDir: path.join(stateDir, "workspace-retired"),
          sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
          deleteFiles: false,
        },
        { env },
      );
      if (changed === "retained") {
        runOpenClawStateWriteTransaction(
          (database) =>
            completeAgentDeletionJournalInDatabase(database, "retired", "delete-retired"),
          { env },
        );
      }
      // The candidate also advances shared state: the old parent cannot reopen it.
      shared.db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    }
    if (changed === "shared" || changed === "agent" || changed === "content-published") {
      setSchema(
        changed === "agent" ? agentPath : shared.path,
        (changed === "agent" ? OPENCLAW_AGENT_SCHEMA_VERSION : OPENCLAW_STATE_SCHEMA_VERSION) + 1,
      );
    }
    await expect(
      inspect({
        result,
        schemaVersions,
        candidateSchemaVersions: {
          state:
            OPENCLAW_STATE_SCHEMA_VERSION +
            Number(contentChange || ["shared", "retained", "pending"].includes(changed)),
          agent: OPENCLAW_AGENT_SCHEMA_VERSION + Number(changed === "incomplete"),
        },
        env,
      }),
    ).resolves.toBe(blocked);
    if (["agent", "incomplete", "pending"].includes(changed)) {
      expect(result).toMatchObject({
        status: "error",
        reason: "openclaw doctor",
        steps: [
          expect.objectContaining({
            exitCode: 1,
            stderrTail: expect.stringContaining(retainedPath ?? agentPath),
          }),
        ],
      });
    } else {
      expect(result).toMatchObject({ status: "ok", steps: [] });
    }
    if (retainedPath) {
      expect(await fs.readFile(retainedPath)).toEqual(retainedBytes);
    }
  },
);

it.each([
  ...[undefined, "voice-call", "@openclaw/voice-call"].flatMap((pluginId) =>
    [false, true].map((enabled) => ({ pluginId, enabled, envKey: undefined })),
  ),
  ...["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"].map((envKey) => ({
    pluginId: undefined,
    enabled: false,
    envKey,
  })),
])(
  "checks schema ownership (plugin=$pluginId, enabled=$enabled, agentEnv=$envKey)",
  async ({ pluginId, enabled, envKey }) => {
    const stateDir = await fs.realpath(dirs.make("update-store-kind-"));
    const store = path.join(stateDir, pluginId ? "configured-store" : "voice-calls");
    const file = envKey
      ? path.join(store, "openclaw-agent.sqlite")
      : path.join(store, "state", "openclaw.sqlite");
    const env = { OPENCLAW_STATE_DIR: stateDir, ...(envKey ? { [envKey]: store } : {}) };
    const config = {
      plugins: {
        enabled,
        entries: { [pluginId ?? "voice-call"]: { enabled, config: pluginId ? { store } : {} } },
      },
    };
    openOpenClawStateDatabase({ env });
    if (envKey) {
      await fs.mkdir(store);
      execNodeEvalSync(`
        const { DatabaseSync } = await import('node:sqlite');
        const writer = new DatabaseSync(${JSON.stringify(file)});
        writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION}; CREATE TABLE retained(value);');
        const reader = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
        reader.exec('BEGIN; SELECT * FROM retained;');
        writer.close();
        reader.exec('COMMIT'); reader.close();
      `);
    } else {
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: store } });
    }
    await closeStateDatabaseForTest();
    const artifacts = envKey ? [file, `${file}-wal`, `${file}-shm`] : [file];
    const before = await Promise.all(artifacts.map((artifact) => fs.readFile(artifact)));
    if (envKey) {
      expect(before[1].length).toBeGreaterThan(32);
    }
    const generations = readUpdateDatabaseGenerations([file]);
    const schemaVersions = [{ path: file, userVersion: OPENCLAW_STATE_SCHEMA_VERSION }];
    const result = updateResult({ root: candidateRoot, durationMs: 0 });
    await expect(inspect({ result, schemaVersions, config, env })).resolves.toBeUndefined();
    expect(result).toMatchObject({
      status: envKey ? "error" : "ok",
      steps: envKey ? [expect.objectContaining({ stderrTail: expect.stringContaining(file) })] : [],
    });
    expect(await Promise.all(artifacts.map((artifact) => fs.readFile(artifact)))).toEqual(before);
    expect(readUpdateDatabaseGenerations([file])).toEqual(generations);
    if (envKey) {
      const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
        env,
        signal: new AbortController().signal,
        warn: (message) => {
          throw new Error(message);
        },
      })!;
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent() {},
      });
      try {
        await capture.admit();
        scope.run(() =>
          capture.run(() => {
            const database = new DatabaseSync(file);
            try {
              runUpdateSqliteMigration(database, file, () => database.exec("PRAGMA user_version"));
            } finally {
              database.close();
            }
          }),
        );
        await capture.settle();
        expect(capture.receipt?.unchanged).toBe(true);
      } finally {
        await scope.close();
      }
    }
  },
);

it("refuses state inspection when activation leaves no known runtime root", async () => {
  const result = updateResult({ status: "error", durationMs: 0 });
  await expect(
    inspect({
      result,
      schemaVersions: [],
      env: { OPENCLAW_STATE_DIR: dirs.make("unknown-update-runtime-") },
    }),
  ).resolves.toBe("rollback-state-unverified");
  expect(result).toMatchObject({
    reason: "rollback-state-unverified",
    steps: [expect.objectContaining({ name: "state-schema-verification", exitCode: 1 })],
  });
});
