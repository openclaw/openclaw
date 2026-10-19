import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { migrateDaemonRuntimePins } from "../../infra/state-migrations.daemon-runtime-pins.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { completeAgentDeletionJournalInDatabase } from "../../state/agent-deletion-journal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";

// The retained updater reads through the real candidate's newer schema contract.
vi.mock("../../state/openclaw-schema-versions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-schema-versions.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

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
])(
  "classifies activation after first-use database creation (agent=$agentId, changed=$changed)",
  async ({ agentId, changed, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-first-serving-turn-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
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
    expect(
      schemaVersions.find((entry) => entry.path === agentPath)?.userVersion ?? null,
    ).toBeNull();

    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(
          database,
          { agentId, sessionKey: `agent:${agentId}:update-check`, sessionId: "serving-check" },
          [
            {
              type: "message",
              id: "request",
              parentId: null,
              message: { role: "user", content: "Reply with update-verified-run" },
            },
            {
              type: "message",
              id: "reply",
              parentId: "request",
              message: {
                role: "assistant",
                content: "update-verified-run",
                provider: "openai",
                model: "gpt-4.1-mini",
                stopReason: "stop",
                __openclaw: { runId: "run" },
              },
            },
          ],
        );
      },
      { agentId, env },
    );
    closeOpenClawAgentDatabasesForTest();
    let retainedPath: string | undefined;
    let retainedBytes: Buffer | undefined;
    if (changed === "retained" || changed === "pending") {
      const agentDir = path.join(stateDir, "agents", "retired", "agent");
      retainedPath = path.join(agentDir, "openclaw-agent.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      const db = new DatabaseSync(retainedPath);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
      db.close();
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
    if (changed === "shared" || changed === "agent") {
      const db = new DatabaseSync(changed === "shared" ? shared.path : agentPath);
      try {
        db.exec(
          `PRAGMA user_version = ${changed === "shared" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
        );
      } finally {
        db.close();
      }
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: candidateRoot,
      steps: [],
      durationMs: 0,
    };
    await expect(
      runtimeFixture.track(
        inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: {
            state:
              OPENCLAW_STATE_SCHEMA_VERSION +
              Number(changed === "shared" || changed === "retained" || changed === "pending"),
            agent: OPENCLAW_AGENT_SCHEMA_VERSION + Number(changed === "incomplete"),
          },
          config: {},
          env,
        }),
      ),
    ).resolves.toBe(blocked);
    if (changed === "local") {
      expect(result.status).toBe("ok");
    }
    if (changed === "incomplete" || changed === "pending") {
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
    } else if (changed === "retained") {
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
      using database = new DatabaseSync(file);
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
    } else {
      openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: store } });
    }
    await closeStateDatabaseForTest();
    const before = await fs.readFile(file);
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
    expect(schemaVersions).toContainEqual(expect.objectContaining({ path: file }));
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: candidateRoot,
      steps: [],
      durationMs: 0,
    };
    await expect(
      runtimeFixture.track(
        inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          config,
          env,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(result).toMatchObject({
      status: envKey ? "error" : "ok",
      steps: envKey ? [expect.objectContaining({ stderrTail: expect.stringContaining(file) })] : [],
    });
    expect(await fs.readFile(file)).toEqual(before);
  },
);

it("refuses state inspection when activation leaves no known runtime root", async () => {
  const result = { status: "error" as const, mode: "npm" as const, steps: [], durationMs: 0 };
  await expect(
    runtimeFixture.track(
      inspectActivatedUpdateState({
        result,
        root: candidateRoot,
        schemaVersions: [],
        config: {},
        env: { OPENCLAW_STATE_DIR: dirs.make("unknown-update-runtime-") },
      }),
    ),
  ).resolves.toBe("rollback-state-unverified");
  expect(result).toMatchObject({
    reason: "rollback-state-unverified",
    steps: [expect.objectContaining({ name: "state-schema-verification", exitCode: 1 })],
  });
});

it.each([
  { beforeContent: false, publish: false, blocked: "state-migrated-no-rollback" },
  { beforeContent: true, publish: false, blocked: undefined },
  { beforeContent: true, publish: true, blocked: undefined },
])(
  "accepts applied shared content through activation (alreadyApplied=$beforeContent, published=$publish)",
  async ({ beforeContent, publish, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-deferred-content-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const contentVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const markContentApplied = () =>
      shared.db
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("state.schema.contentVersion", JSON.stringify(contentVersion), Date.now());
    if (beforeContent) {
      markContentApplied();
    }
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    markContentApplied();
    if (publish) {
      shared.db.exec(`PRAGMA user_version = ${contentVersion};`);
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: candidateRoot,
      steps: [],
      durationMs: 0,
    };
    await expect(
      runtimeFixture.track(
        inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: { state: contentVersion, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
          config: {},
          env,
        }),
      ),
    ).resolves.toBe(blocked);
    expect(result).toMatchObject({ status: "ok", steps: [] });
    expect(shared.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      publish ? contentVersion : OPENCLAW_STATE_SCHEMA_VERSION,
    );
  },
);
