import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  AgentHarness,
  AgentHarnessSessionDeletionParams,
} from "../../agents/harness/types.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  beginSessionWorkAdmission,
  isCompetingSessionWorkAdmissionActive,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import * as personalPublicationLifecycle from "../../state/github-personal-publication-lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "./session-accessor.js";
import * as sessionArchive from "./session-accessor.sqlite-archive.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = createTempDirTracker();

describe("session deletion and native owner state", () => {
  let storePath: string;
  const sessionKey = "agent:main:cron:cleanup:run:session";
  const baseKey = "agent:main:cron:cleanup";
  const sessionId = "cleanup-session";
  let bindings: Map<string, string>;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-deletion-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    bindings = new Map();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
    vi.unstubAllEnvs();
  });

  function nativeOwner(
    options: {
      activate?: boolean;
      prepare?: (params: AgentHarnessSessionDeletionParams) => Promise<void>;
      finalize?: () => Promise<void>;
      afterCommit?: (key: string) => void;
      afterRollback?: (key: string) => void;
    } = {},
  ) {
    const registry = createEmptyPluginRegistry();
    const harness: AgentHarness = {
      id: "native-test",
      label: "Native test owner",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      withSessionDeletion: async (params, run) => {
        await options.prepare?.(params);
        params.assertCurrent();
        const before = bindings.get(params.sessionKey);
        let committed = false;
        const result = await run({
          commit: () => {
            params.assertCurrent();
            if (bindings.get(params.sessionKey) !== before) {
              throw new Error("native binding owner changed");
            }
            bindings.delete(params.sessionKey);
            committed = true;
            options.afterCommit?.(params.sessionKey);
          },
          rollback: () => {
            params.assertCurrent();
            if (before !== undefined && !bindings.has(params.sessionKey)) {
              bindings.set(params.sessionKey, before);
            }
            committed = false;
            options.afterRollback?.(params.sessionKey);
          },
        });
        if (committed) {
          await options.finalize?.();
          params.assertCurrent();
        }
        return result;
      },
    };
    const record = createPluginRecord({ id: "native-owner" });
    registry.plugins.push(record);
    registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
    if (options.activate !== false) {
      markPluginRegistryActive(registry);
    }
    return {
      record,
      registry,
      run: <T>(operation: () => Promise<T>) => withPluginRuntimeRegistryScope(registry, operation),
    };
  }

  async function seed(key = sessionKey, harnessId: string | null = "native-test") {
    await replaceSessionEntry(
      { sessionKey: key, storePath },
      {
        sessionId,
        lifecycleRevision: "generation-1",
        updatedAt: Date.now(),
        ...(harnessId ? { agentHarnessId: harnessId } : {}),
      },
    );
    bindings.set(key, `thread:${key}`);
  }

  const remove = (key = sessionKey) =>
    deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: key, storeKeys: [key] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
  const read = (key = sessionKey) =>
    loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" });

  it("cleans repository state in the explicit environment and preserves the ambient same-key session", async () => {
    const ambientEnv = { ...process.env };
    const ambientRepositories = createSessionRepositoryWorkspaceStore({ env: ambientEnv });
    const ambientRepository = await ambientRepositories.create({
      agentId: "main",
      sessionKey,
      url: "https://github.com/openclaw/fixture.git",
      assertCurrent: () => {},
    });
    const ambientScope = { agentId: "main", sessionKey, storePath, env: ambientEnv };
    await replaceSessionEntry(ambientScope, {
      sessionId: "ambient-sentinel",
      updatedAt: 1,
      repositoryWorkspaceId: ambientRepository.workspaceId,
    });
    const ambientEntry = loadSessionEntry(ambientScope);
    expect(ambientEntry).toMatchObject({ sessionId: "ambient-sentinel" });
    const ambientArtifactRoot = ambientRepositories.artifactPath(ambientRepository.workspaceId);
    const ambientArtifact = path.join(ambientArtifactRoot, "checkpoint");
    await fs.mkdir(ambientArtifactRoot, { recursive: true });
    await fs.writeFile(ambientArtifact, "ambient checkpoint");

    await withOpenClawTestState(
      { label: "repository-cleanup-explicit-env", applyEnv: false },
      async (state) => {
        expect(state.env.OPENCLAW_STATE_DIR).not.toBe(process.env.OPENCLAW_STATE_DIR);
        const explicitStorePath = path.join(state.sessionsDir(), "sessions.json");
        const scope = { agentId: "main", sessionKey, storePath: explicitStorePath, env: state.env };
        const repositories = createSessionRepositoryWorkspaceStore({ env: state.env });
        expect(repositories.path).not.toBe(ambientRepositories.path);
        const repository = await repositories.create({
          agentId: "main",
          sessionKey,
          url: "https://github.com/openclaw/fixture.git",
          assertCurrent: () => {},
        });
        await replaceSessionEntry(scope, {
          sessionId: "explicit-environment-session",
          updatedAt: 1,
          repositoryWorkspaceId: repository.workspaceId,
        });
        const artifactRoot = repositories.artifactPath(repository.workspaceId);
        await fs.mkdir(artifactRoot, { recursive: true });
        await fs.writeFile(path.join(artifactRoot, "checkpoint"), "explicit checkpoint");

        const result = await applySessionEntryLifecycleMutation({
          agentId: "main",
          env: state.env,
          storePath: explicitStorePath,
          removals: [{ sessionKey }],
          skipMaintenance: true,
        });

        expect(result.removedSessionKeys).toEqual([sessionKey]);
        expect(loadSessionEntry(scope)).toBeUndefined();
        expect(await repositories.get(repository.workspaceId)).toBeUndefined();
        await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect(loadSessionEntry(ambientScope)).toEqual(ambientEntry);
        expect(await ambientRepositories.get(ambientRepository.workspaceId)).toEqual(
          ambientRepository,
        );
        expect(await fs.readFile(ambientArtifact, "utf8")).toBe("ambient checkpoint");
      },
    );
  });

  it("cleans a logical global owner's repository in a shared physical store and preserves its sibling", async () => {
    await withOpenClawTestState({ label: "repository-cleanup-shared-owner" }, async (state) => {
      const sharedStorePath = state.statePath("shared.sqlite");
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {}, worker: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { scope: "global", store: sharedStorePath },
      });
      openOpenClawAgentDatabase({ agentId: "main", path: sharedStorePath, env: state.env });
      const repositories = createSessionRepositoryWorkspaceStore({ env: state.env });
      const scope = {
        agentId: "ops",
        sessionKey: "global",
        storePath: sharedStorePath,
        env: state.env,
      };
      const siblingScope = { ...scope, agentId: "worker", sessionKey: "agent:worker:task" };
      const repository = await repositories.create({
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        url: "https://github.com/openclaw/fixture.git",
        assertCurrent: () => {},
      });
      const siblingRepository = await repositories.create({
        agentId: siblingScope.agentId,
        sessionKey: siblingScope.sessionKey,
        url: "https://github.com/openclaw/fixture.git",
        assertCurrent: () => {},
      });
      await replaceSessionEntry(scope, {
        sessionId: "global-session",
        updatedAt: 1,
        repositoryWorkspaceId: repository.workspaceId,
      });
      await replaceSessionEntry(siblingScope, {
        sessionId: "worker-sibling",
        updatedAt: 1,
        repositoryWorkspaceId: siblingRepository.workspaceId,
      });
      const siblingEntry = loadSessionEntry(siblingScope);
      expect(siblingEntry).toMatchObject({ sessionId: "worker-sibling" });
      const artifactRoot = repositories.artifactPath(repository.workspaceId);
      const siblingArtifactRoot = repositories.artifactPath(siblingRepository.workspaceId);
      const siblingArtifact = path.join(siblingArtifactRoot, "checkpoint");
      await fs.mkdir(artifactRoot, { recursive: true });
      await fs.writeFile(path.join(artifactRoot, "checkpoint"), "global checkpoint");
      await fs.mkdir(siblingArtifactRoot, { recursive: true });
      await fs.writeFile(siblingArtifact, "worker checkpoint");
      expect(resolveSqliteScope(scope)).toMatchObject({
        agentId: "ops",
        databaseAgentId: "main",
        path: sharedStorePath,
      });

      const result = await applySessionEntryLifecycleMutation({
        agentId: "ops",
        env: state.env,
        storePath: sharedStorePath,
        removals: [{ sessionKey: "global" }],
        skipMaintenance: true,
      });

      expect(result.removedSessionKeys).toEqual(["global"]);
      expect(loadSessionEntry(scope)).toBeUndefined();
      expect(await repositories.get(repository.workspaceId)).toBeUndefined();
      await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(loadSessionEntry(siblingScope)).toEqual(siblingEntry);
      expect(await repositories.get(siblingRepository.workspaceId)).toEqual(siblingRepository);
      expect(await fs.readFile(siblingArtifact, "utf8")).toBe("worker checkpoint");
    });
  });

  it.each([
    { deleteWindows: false, sparse: false, rejectSuggestions: false },
    { deleteWindows: true, sparse: true, rejectSuggestions: false },
    { deleteWindows: true, sparse: false, rejectSuggestions: true },
  ])(
    "clears node artifacts without repeated inventories (delete windows: $deleteWindows, sparse: $sparse, reject suggestions: $rejectSuggestions)",
    async ({ deleteWindows, sparse, rejectSuggestions }) => {
      const run = async () => {
        await seed();
        const otherKey = "agent:main:unrelated-artifacts";
        await replaceSessionEntry(
          { sessionKey: otherKey, storePath },
          { sessionId: "unrelated-artifacts", updatedAt: Date.now() },
        );
        const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
        const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
        for (const key of [sessionKey, otherKey]) {
          recordSessionParticipant(
            { sessionKey: key, storePath },
            { identity: { type: "profile", id: "artifact-person" }, promptedAt: 10 },
          );
          database.db
            .prepare(
              "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'main', 'Main', 0, 'user', 1)",
            )
            .run(key);
          database.db
            .prepare(
              "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'card', 'main', 'plugin', '{}', 'fixture', 1, 1, 1, 0, 'user', 10, 10)",
            )
            .run(key);
          if (!sparse) {
            database.db
              .prepare(
                "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
              )
              .run(key, "artifact-person", "owner", 10);
            database.db
              .prepare(
                "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                `suggestion:${key}`,
                key,
                "artifact-person",
                "Keep this suggestion",
                10,
                "pending",
              );
          }
        }
        if (sparse) {
          database.db.exec("DROP TABLE session_members; DROP TABLE session_suggestions;");
        }
        const artifactRows = () =>
          [
            "session_participants",
            "session_members",
            "session_suggestions",
            "board_tabs",
            "board_widgets",
          ].map((table) =>
            sparse && (table === "session_members" || table === "session_suggestions")
              ? []
              : database.db.prepare(`SELECT * FROM ${table} ORDER BY session_key`).all(),
          );
        const before = artifactRows();
        const entryBefore = read();
        const otherBefore = read(otherKey);
        const readWindows = () =>
          database.db.prepare("SELECT * FROM session_windows ORDER BY session_id").all();
        const windowsBefore = readWindows();
        if (rejectSuggestions) {
          database.db
            .exec(`CREATE TEMP TRIGGER reject_artifact_delete BEFORE DELETE ON session_suggestions
            WHEN OLD.session_key = '${sessionKey}' BEGIN
            SELECT CASE WHEN EXISTS (SELECT 1 FROM session_members WHERE session_key = OLD.session_key)
              THEN RAISE(ABORT, 'membership deletion order changed')
              ELSE RAISE(ABORT, 'injected suggestion deletion failure') END;
            END`);
        }
        const owner = nativeOwner();
        const counter = trackSqliteStatementExecutions(database.db, ["inventory"], (sql) =>
          /^select "name" from "sqlite_schema" where "type" = \? and "name" in \(/i.test(sql)
            ? "inventory"
            : null,
        );
        try {
          const deletion = deleteWindows
            ? owner.run(() =>
                applySessionEntryLifecycleMutation({
                  storePath,
                  removals: [{ sessionKey, deleteOwnedWindows: true }],
                  skipMaintenance: true,
                }),
              )
            : owner.run(() =>
                deleteSessionEntryLifecycle({
                  agentId: "main",
                  storePath,
                  target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                  archiveTranscript: false,
                }),
              );
          if (rejectSuggestions) {
            const error = await deletion.catch((caughtError: unknown) => caughtError);
            expect(error).toBeInstanceOf(Error);
            expect(error).toMatchObject({
              code: "ERR_SQLITE_ERROR",
              message: "injected suggestion deletion failure",
            });
          } else {
            await expect(deletion).resolves.toMatchObject(
              deleteWindows ? { removedSessionKeys: [sessionKey] } : { deleted: true },
            );
          }
          if (deleteWindows) {
            // Admitted schema facts already own the node artifact inventory.
            expect.soft(counter.counts.inventory).toBe(0);
          }
          // Both artifact owners reuse the schema admitted before deletion.
          const inventoryBudget = deleteWindows ? 0 : 1;
          expect.soft(counter.counts.inventory).toBeLessThanOrEqual(inventoryBudget);
        } finally {
          counter.restore();
        }
        expect(read(otherKey)).toEqual(otherBefore);
        if (rejectSuggestions) {
          expect(artifactRows()).toEqual(before);
          expect(read()).toEqual(entryBefore);
          expect(readWindows()).toEqual(windowsBefore);
          expect(bindings.get(sessionKey)).toBe(`thread:${sessionKey}`);
        } else {
          expect(artifactRows()).toEqual(
            before.map((rows) => rows.filter((row) => row.session_key === otherKey)),
          );
          expect(read()).toBeUndefined();
          expect(bindings.has(sessionKey)).toBe(false);
          expect(readWindows()).toEqual(
            deleteWindows
              ? windowsBefore.filter((window) => window.session_key !== sessionKey)
              : windowsBefore,
          );
          expect(
            database.db
              .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
              .get(sessionKey),
          ).toEqual(deleteWindows ? undefined : { entry_valid: -1 });
          if (sparse) {
            expect(
              database.db
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE name IN ('session_members', 'session_suggestions')",
                )
                .all(),
            ).toEqual([]);
          }
        }
      };
      if (sparse) {
        // Deliberately incomplete schema belongs to Doctor's native maintenance owner.
        const schemaOwner = acquireGatewayStateOwner({
          databasePath: resolveOpenClawStateSqlitePath(),
        });
        const maintenance = createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: schemaOwner.assertCurrent,
          assertDatabaseAccess: schemaOwner.assertDatabaseAccess,
        });
        try {
          await maintenance.run(run);
        } finally {
          try {
            await maintenance.close();
          } finally {
            schemaOwner.release();
          }
        }
      } else {
        await run();
      }
    },
  );

  it.each(["a shared window", "a placeholder successor"] as const)(
    "does not materialize surviving prompts when deleting a node with %s",
    async (scenario) => {
      const reclaimedKey = "agent:main:reclaimed-node";
      const survivorKeys = ["agent:main:survivor-a", "agent:main:survivor-b"] as const;
      const entry = { sessionId: "reclaimed-session", updatedAt: Date.now() };
      const retainedEvent = { type: "session", id: entry.sessionId, content: "retained history" };
      await replaceSessionEntry({ sessionKey: reclaimedKey, storePath }, entry);
      for (const survivorKey of survivorKeys.toReversed()) {
        await replaceSessionEntry(
          { sessionKey: survivorKey, storePath },
          {
            sessionId: `${survivorKey}-session`,
            previousSessionId: entry.sessionId,
            updatedAt: entry.updatedAt,
            skillsSnapshot: { prompt: "saved skill prompt".repeat(4096), skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: entry.updatedAt,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [{ name: "saved-report-skill", blockChars: 0 }] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
          },
        );
      }
      const scope = {
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      };
      const database = openOpenClawAgentDatabase(scope);
      replaceTranscriptEventsSync(
        { sessionKey: reclaimedKey, sessionId: entry.sessionId, storePath },
        [retainedEvent],
      );
      if (scenario === "a placeholder successor") {
        database.db
          .prepare(
            "UPDATE session_nodes SET current_session_id = ?, entry_json = '{}', entry_valid = -1 WHERE session_key = ?",
          )
          .run(entry.sessionId, survivorKeys[0]);
      }
      const readSurvivors = () =>
        database.db
          .prepare(
            "SELECT session_key, current_session_id, entry_json, entry_valid FROM session_nodes WHERE session_key != ? ORDER BY session_key",
          )
          .all(reclaimedKey);
      const survivorsBefore = readSurvivors();
      const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
      try {
        await withSqliteSessionDeletions(scope, [{ sessionKey: reclaimedKey, entry }], async () => {
          runSqliteSessionDeletionTransaction((current) => {
            deleteSessionEntryRows(current, reclaimedKey, {
              deleteOwnedWindows: scenario === "a shared window",
            });
          }, scope);
        });
        const rows = queries.mock.results.flatMap((result) =>
          result.type === "return" ? result.value.rows : [],
        );
        for (const payload of ["saved skill prompt", "saved-report-skill"]) {
          expect(JSON.stringify(rows)).not.toContain(payload);
        }
      } finally {
        queries.mockRestore();
      }
      expect(loadSessionEntry({ sessionKey: reclaimedKey, storePath })).toBeUndefined();
      expect(readSurvivors()).toEqual(survivorsBefore);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(entry.sessionId),
      ).toEqual({ session_key: survivorKeys[0] });
      await expect(
        loadTranscriptEvents({
          sessionKey: survivorKeys[0],
          sessionId: entry.sessionId,
          storePath,
        }),
      ).resolves.toEqual([retainedEvent]);
    },
  );

  it("patches a case-distinct Matrix room without preparing its admitted sibling for deletion", async () => {
    const mixedKey = "agent:main:matrix:channel:!RoomAbC:example.org";
    const lowerKey = "agent:main:matrix:channel:!roomabc:example.org";
    for (const [key, id, room] of [
      [mixedKey, "mixed-session", "!RoomAbC:example.org"],
      [lowerKey, "lower-session", "!roomabc:example.org"],
    ] as const) {
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        {
          sessionId: id,
          lifecycleRevision: `generation:${id}`,
          updatedAt: Date.now(),
          agentHarnessId: "native-test",
          delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to: room } }),
        },
      );
      bindings.set(key, `thread:${key}`);
    }
    const siblingBefore = read(lowerKey);
    const bindingsBefore = new Map(bindings);
    const prepare = vi.fn(async () => {});
    const owner = nativeOwner({ prepare });
    const identities = [lowerKey, "lower-session"];
    const onInterrupt = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities,
      assertAllowed: () => {},
      onInterrupt,
    });
    try {
      const patched = await owner.run(() =>
        patchSessionEntryCore(
          { sessionKey: mixedKey, storePath },
          () => ({ label: "updated room" }),
          { skipMaintenance: true },
        ),
      );

      expect(patched).toMatchObject({ sessionId: "mixed-session", label: "updated room" });
      expect(read(mixedKey)).toEqual(patched);
      expect(read(lowerKey)).toEqual(siblingBefore);
      expect(bindings).toEqual(bindingsBefore);
      expect(prepare).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(isSessionWorkAdmissionActive(storePath, identities)).toBe(true);
      expect(isCompetingSessionWorkAdmissionActive(storePath, identities)).toBe(true);
      await admission.run(async () => {
        expect(isCompetingSessionWorkAdmissionActive(storePath, identities)).toBe(false);
      });
    } finally {
      admission.release();
    }
  });

  it("honors identity guards and deletes ownership with or without recorded harness metadata", async () => {
    await seed(sessionKey, null);
    await seed(baseKey);
    const owner = nativeOwner();

    await expect(
      owner.run(() =>
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          expectedSessionId: null,
        }),
      ),
    ).resolves.toEqual({
      archivedTranscripts: [],
      deleted: false,
      expectedEntryMismatch: true,
    });
    expect(read()).toMatchObject({ sessionId });
    expect(bindings.has(sessionKey)).toBe(true);

    const sql = observeHostDataSql();
    try {
      await expect(owner.run(() => remove())).resolves.toMatchObject({ deleted: true });
      expect(
        sql.queries.filter((query) =>
          /\b(?:session_nodes|session_windows|transcript_events)\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }

    expect(read()).toBeUndefined();
    expect(bindings.has(sessionKey)).toBe(false);
    expect(read(baseKey)?.sessionId).toBe(sessionId);
    expect(bindings.has(baseKey)).toBe(true);
    await owner.run(() => remove(baseKey));
    expect(bindings.size).toBe(0);
  });

  it.each(["owner preparation", "SQLite transaction"] as const)(
    "preserves the entry, transcript, and native binding when %s fails",
    async (phase) => {
      await seed();
      const events = [{ type: "session", id: sessionId }];
      replaceTranscriptEventsSync({ sessionKey, sessionId, storePath }, events);
      const entryBefore = read();
      const afterCommit = vi.fn();
      const failure =
        phase === "owner preparation"
          ? "native session is supervised"
          : "injected session delete failure";
      if (phase === "SQLite transaction") {
        const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
        const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
        database.db.exec(
          "CREATE TRIGGER reject_session_delete BEFORE DELETE ON session_nodes BEGIN SELECT RAISE(ABORT, 'injected session delete failure'); END",
        );
      }
      const owner = nativeOwner({
        prepare: async () => {
          if (phase === "owner preparation") {
            throw new Error(failure);
          }
        },
        afterCommit,
      });

      await expect(owner.run(() => remove())).rejects.toThrow(failure);

      expect(afterCommit).not.toHaveBeenCalled();
      expect(read()).toEqual(entryBefore);
      expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual(events);
      expect(bindings.get(sessionKey)).toBe(`thread:${sessionKey}`);
    },
  );

  it("keeps deletion successful and the binding absent when a publication observer fails", async () => {
    await seed();
    const owner = nativeOwner();
    const listener = vi.fn(() => {
      throw new Error("injected publication failure");
    });
    const unsubscribe = onSessionIdentityMutation(listener);

    try {
      await expect(
        owner.run(() =>
          applySessionEntryLifecycleMutation({
            storePath,
            removals: [{ sessionKey }],
            skipMaintenance: true,
          }),
        ),
      ).resolves.toMatchObject({ removedSessionKeys: [sessionKey] });

      expect(listener).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "delete",
          previous: { sessionId, sessionKeys: [sessionKey] },
        }),
      );
      expect(read()).toBeUndefined();
      expect(bindings.has(sessionKey)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("publishes committed deletion when personal publication receipt cleanup fails", async () => {
    await seed();
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    const file = statSync(target.path, { bigint: true });
    const owner = nativeOwner();
    const cleanupError = new Error("injected receipt cleanup failure");
    vi.spyOn(
      personalPublicationLifecycle,
      "preparePersonalGitHubSessionReceiptDeletion",
    ).mockResolvedValueOnce(async () => {
      throw cleanupError;
    });
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      await expect(owner.run(() => remove())).rejects.toBe(cleanupError);

      expect(read()).toBeUndefined();
      expect(bindings.has(sessionKey)).toBe(false);
      expect(identityListener).toHaveBeenCalledExactlyOnceWith({
        agentId: "main",
        databaseIdentity: `${file.dev}:${file.ino}`,
        kind: "delete",
        previous: { sessionId, sessionKeys: [sessionKey] },
      });
    } finally {
      unsubscribe();
    }
  });

  it("keeps requested deletions durable when legacy companion cleanup fails", async () => {
    await seed();
    await seed(baseKey);
    const survivorKey = "agent:main:survivor";
    await seed(survivorKey);
    const commitError = new Error("companion commit failed after mutation");
    let commits = 0;
    const rollback = vi.fn();
    const committedKeys: string[] = [];
    const owner = nativeOwner({
      afterCommit: (key) => {
        expect(read(key)).toBeUndefined();
        committedKeys.push(key);
        if (++commits === 2) {
          throw commitError;
        }
      },
      afterRollback: rollback,
    });
    const deletion = owner.run(() =>
      applySessionEntryLifecycleMutation({
        storePath,
        skipMaintenance: true,
        removals: [{ sessionKey: baseKey }, { sessionKey }],
      }),
    );
    await expect(deletion).resolves.toMatchObject({
      removedSessionKeys: [baseKey, sessionKey],
    });
    expect(committedKeys).toEqual([baseKey, sessionKey]);
    expect(rollback).not.toHaveBeenCalled();
    expect(read()).toBeUndefined();
    expect(read(baseKey)).toBeUndefined();
    expect(bindings.has(sessionKey)).toBe(false);
    expect(bindings.has(baseKey)).toBe(false);
    expect(read(survivorKey)?.sessionId).toBe(sessionId);
    expect(bindings.get(survivorKey)).toBe(`thread:${survivorKey}`);
  });

  it.for(["prepare", "finalize"] as const)(
    "lets unrelated session writers progress during native %s",
    async (phase, { signal }) => {
      await seed();
      await seed(baseKey);
      const entered = createDeferred();
      const release = createDeferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const owner = nativeOwner(phase === "prepare" ? { prepare: wait } : { finalize: wait });
      const deletion = owner.run(() => remove());
      try {
        // Native cleanup stays held; bind waits to the test so a stall still releases it below.
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            deletion,
            "native deletion settled before preparation or finalization",
          ),
          signal,
        );
        await withinTest(
          owner.run(() =>
            patchSessionEntryCore({ sessionKey: baseKey, storePath }, () => ({
              label: "writer progressed",
            })),
          ),
          signal,
        );
        expect(read(baseKey)?.label).toBe("writer progressed");
      } finally {
        release.resolve();
        await deletion;
      }
    },
  );

  it("keeps the exact prepared owner through publication and expires it on return", async () => {
    await seed();
    let retainedGuard: (() => void) | undefined;
    const owner = nativeOwner({
      activate: false,
      prepare: async ({ assertCurrent }) => {
        retainedGuard = assertCurrent;
        markPluginRegistryActive(owner.registry);
      },
    });
    await owner.run(() => remove());
    expect(read()).toBeUndefined();
    expect(bindings.has(sessionKey)).toBe(false);
    expect(() => retainedGuard?.()).toThrow("harness owner changed");
  });

  it.each(["reactivated", "record revoked", "registration replaced"] as const)(
    "rejects a prepared owner after its registry is %s",
    async (change) => {
      await seed();
      const entered = createDeferred();
      const release = createDeferred();
      const owner = nativeOwner({
        activate: false,
        prepare: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const deletion = owner.run(() => remove());
      const rejected = expect(deletion).rejects.toThrow("harness owner changed");
      await entered.promise;
      if (change === "reactivated") {
        markPluginRegistryRetired(owner.registry);
        markPluginRegistryActive(owner.registry);
      } else if (change === "record revoked") {
        revokePluginRecord(owner.registry, owner.record);
      } else {
        owner.registry.agentHarnesses = owner.registry.agentHarnesses.map((registration) =>
          Object.assign({}, registration),
        );
      }
      release.resolve();
      await rejected;
      expect(read()?.sessionId).toBe(sessionId);
      expect(bindings.has(sessionKey)).toBe(true);
    },
  );

  it("rejects a captured prepared owner invoked under a different registry scope", async () => {
    await seed();
    const other = createEmptyPluginRegistry();
    const owner = nativeOwner({
      activate: false,
      prepare: async ({ assertCurrent }) => {
        withPluginRuntimeRegistryScope(other, assertCurrent);
      },
    });
    await expect(owner.run(() => remove())).rejects.toThrow("harness owner changed");
    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.has(sessionKey)).toBe(true);
  });

  it("preserves history when its native owner retires during archive materialization", async () => {
    const historicalId = "historical-cleanup-session";
    const historicalEvent = { type: "session", id: historicalId, content: "retained history" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalId, updatedAt: Date.now() },
    );
    expect(
      replaceTranscriptEventsSync({ sessionKey, sessionId: historicalId, storePath }, [
        historicalEvent,
      ]),
    ).toBe(true);
    await seed();
    const materialize = sessionArchive.materializeSessionStateDeletePlans;
    const owner = nativeOwner();
    vi.spyOn(sessionArchive, "materializeSessionStateDeletePlans").mockImplementationOnce(
      async (...args) => {
        const result = await materialize(...args);
        // Retire at the pre-commit boundary, independent of archive Worker latency.
        markPluginRegistryRetired(owner.registry);
        return result;
      },
    );
    const deletion = owner.run(() =>
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        archiveTranscript: true,
      }),
    );
    await expect(deletion).rejects.toThrow("harness owner changed");
    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.has(sessionKey)).toBe(true);
    expect(await loadTranscriptEvents({ sessionKey, sessionId: historicalId, storePath })).toEqual([
      historicalEvent,
    ]);
  });

  it.each(["entry replacement", "lifecycle removal", "maintenance"] as const)(
    "preserves successor bindings and removes deleted keys through %s",
    async (surface) => {
      await seed();
      const owner = nativeOwner();
      await owner.run(async () => {
        if (surface === "entry replacement") {
          await applySessionEntryReplacements({
            storePath,
            sessionKeys: [sessionKey],
            skipMaintenance: true,
            update: (entries) => ({
              result: undefined,
              replacements: entries.map(({ entry, sessionKey: key }) => ({
                sessionKey: key,
                entry: { ...entry, sessionId: "replacement-session" },
              })),
            }),
          });
          return;
        }
        if (surface === "lifecycle removal") {
          await applySessionEntryLifecycleMutation({
            storePath,
            skipMaintenance: true,
            removals: [{ sessionKey }],
          });
          return;
        }
        await applySessionEntryLifecycleMutation({
          storePath,
          maintenanceOverride: {
            mode: "enforce",
            maxEntries: 0,
            pruneAfterMs: Number.MAX_SAFE_INTEGER,
            preserveRecentMs: 0,
          },
        });
      });
      expect(bindings.has(sessionKey)).toBe(surface === "entry replacement");
      expect(read()?.sessionId).toBe(
        surface === "entry replacement" ? "replacement-session" : undefined,
      );
    },
  );
});
