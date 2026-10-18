import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import type {
  AgentHarness,
  AgentHarnessSessionDeletionParams,
} from "../../agents/harness/types.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  beginSessionEffect,
  isCompetingSessionControllerWorkActive,
  isSessionControllerWorkActive,
} from "../../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import * as personalPublicationLifecycle from "../../state/github-personal-publication-lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
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

const artifactDeletionFault = useSqliteWorkerFault([
  {
    name: "reject_artifact_delete",
    match: /^delete from session_suggestions\b/u,
    sql: `CREATE TEMP TRIGGER reject_artifact_delete BEFORE DELETE ON main.session_suggestions
      BEGIN
        SELECT CASE WHEN EXISTS (SELECT 1 FROM session_members WHERE session_key = OLD.session_key)
          THEN RAISE(ABORT, 'membership deletion order changed')
          ELSE RAISE(ABORT, 'injected suggestion deletion failure') END;
      END`,
  },
]);

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-deletion-");

describe("session deletion and native owner state", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:cron:cleanup:run:session";
  const baseKey = "agent:main:cron:cleanup";
  const sessionId = "cleanup-session";
  let bindings: Map<string, string>;

  beforeEach(() => {
    tempDir = tempDirs.make();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    bindings = new Map();
  });

  afterEach(async () => {
    try {
      // Retire scheduled maintenance before the next case changes its environment.
      await closeOpenClawAgentDatabasesAsync(tempDir);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
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

  const scopeFor = (key = sessionKey) => ({ sessionKey: key, storePath });
  const transcript = (id = sessionId, key = sessionKey) => ({ ...scopeFor(key), sessionId: id });
  const write = (key: string, entry: Parameters<typeof replaceSessionEntry>[1]) =>
    replaceSessionEntry(scopeFor(key), entry);
  async function seed(key = sessionKey, harnessId: string | null = "native-test") {
    await write(key, {
      sessionId,
      lifecycleRevision: "generation-1",
      updatedAt: Date.now(),
      ...(harnessId ? { agentHarnessId: harnessId } : {}),
    });
    bindings.set(key, `thread:${key}`);
  }

  const deleteEntry = (
    options: Partial<Parameters<typeof deleteSessionEntryLifecycle>[0]> = {},
    key = sessionKey,
  ) =>
    deleteSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: key, storeKeys: [key] },
      archiveTranscript: false,
      ...options,
    });
  const remove = (key = sessionKey) =>
    deleteEntry({ agentId: "main", deleteTranscriptWithoutArchive: true }, key);
  const mutate = (
    options: Omit<Parameters<typeof applySessionEntryLifecycleMutation>[0], "storePath">,
  ) => applySessionEntryLifecycleMutation({ storePath, ...options });
  const removeNodes = (keys = [sessionKey]) =>
    mutate({ removals: keys.map((key) => ({ sessionKey: key })), skipMaintenance: true });
  const read = (key = sessionKey) =>
    loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" });

  async function seedRepository(
    repositories: ReturnType<typeof createSessionRepositoryWorkspaceStore>,
    scope: Parameters<typeof replaceSessionEntry>[0] & { agentId: string; sessionKey: string },
    id: string,
    checkpoint: string,
  ) {
    const repository = await repositories.create({
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      url: "https://github.com/openclaw/fixture.git",
      assertCurrent() {},
    });
    await replaceSessionEntry(scope, {
      sessionId: id,
      updatedAt: 1,
      repositoryWorkspaceId: repository.workspaceId,
    });
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({ sessionId: id });
    const artifactRoot = repositories.artifactPath(repository.workspaceId);
    const artifact = path.join(artifactRoot, "checkpoint");
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(artifact, checkpoint);
    return { repository, entry, artifactRoot, artifact };
  }

  it.each(["explicit environment", "shared physical store"] as const)(
    "cleans the repository in its %s and preserves the sibling",
    async (mode) => {
      const shared = mode === "shared physical store";
      const ambientEnv = { ...process.env };
      const ambientScope = { agentId: "main", sessionKey, storePath, env: ambientEnv };
      const ambientRepositories = createSessionRepositoryWorkspaceStore({ env: ambientEnv });
      const ambient = shared
        ? undefined
        : await seedRepository(
            ambientRepositories,
            ambientScope,
            "ambient-sentinel",
            "ambient checkpoint",
          );
      await withOpenClawTestState(
        { label: "repository-cleanup", applyEnv: shared },
        async (state) => {
          const targetPath = shared
            ? state.statePath("shared.sqlite")
            : path.join(state.sessionsDir(), "sessions.json");
          if (shared) {
            await state.writeConfig({
              agents: {
                ownership: "explicit",
                entries: { main: {}, ops: {}, worker: {} },
                defaults: { sessionStore: { agentId: "ops" } },
              },
              session: { scope: "global", store: targetPath },
            });
            openOpenClawAgentDatabase({ agentId: "main", path: targetPath, env: state.env });
          } else {
            expect(state.env.OPENCLAW_STATE_DIR).not.toBe(process.env.OPENCLAW_STATE_DIR);
          }
          const scope = {
            agentId: shared ? "ops" : "main",
            sessionKey: shared ? "global" : sessionKey,
            storePath: targetPath,
            env: state.env,
          };
          const repositories = createSessionRepositoryWorkspaceStore({ env: state.env });
          const siblingScope = shared
            ? { ...scope, agentId: "worker", sessionKey: "agent:worker:task" }
            : ambientScope;
          const siblingRepositories = shared ? repositories : ambientRepositories;
          const sibling =
            ambient ??
            (await seedRepository(
              repositories,
              siblingScope,
              "worker-sibling",
              "worker checkpoint",
            ));
          const { repository, artifactRoot } = await seedRepository(
            repositories,
            scope,
            shared ? "global-session" : "explicit-environment-session",
            shared ? "global checkpoint" : "explicit checkpoint",
          );
          if (shared) {
            expect(resolveSqliteScope(scope)).toMatchObject({
              agentId: "ops",
              databaseAgentId: "main",
              path: targetPath,
            });
          } else {
            expect(repositories.path).not.toBe(ambientRepositories.path);
          }
          const result = await applySessionEntryLifecycleMutation({
            ...scope,
            removals: [{ sessionKey: scope.sessionKey }],
            skipMaintenance: true,
          });
          expect(result.removedSessionKeys).toEqual([scope.sessionKey]);
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(await repositories.get(repository.workspaceId)).toBeUndefined();
          await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
          expect(loadSessionEntry(siblingScope)).toEqual(sibling.entry);
          expect(await siblingRepositories.get(sibling.repository.workspaceId)).toEqual(
            sibling.repository,
          );
          expect(await fs.readFile(sibling.artifact, "utf8")).toBe(
            shared ? "worker checkpoint" : "ambient checkpoint",
          );
        },
      );
    },
  );

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
        await write(otherKey, { sessionId: "unrelated-artifacts", updatedAt: Date.now() });
        const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
        const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
        const insert = (sql: string, ...values: (string | number)[]) =>
          database.db.prepare(sql).run(...values);
        const query = (sql: string, ...values: (string | number)[]) =>
          database.db.prepare(sql).all(...values);
        for (const key of [sessionKey, otherKey]) {
          recordSessionParticipant(
            { sessionKey: key, storePath },
            { identity: { type: "profile", id: "artifact-person" }, promptedAt: 10 },
          );
          insert(
            "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'main', 'Main', 0, 'user', 1)",
            key,
          );
          insert(
            "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'card', 'main', 'plugin', '{}', 'fixture', 1, 1, 1, 0, 'user', 10, 10)",
            key,
          );
          if (!sparse) {
            insert(
              "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, 'artifact-person', 'owner', 10)",
              key,
            );
            insert(
              "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, 'artifact-person', 'Keep this suggestion', 10, 'pending')",
              `suggestion:${key}`,
              key,
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
              : query(`SELECT * FROM ${table} ORDER BY session_key`),
          );
        const before = artifactRows();
        const entryBefore = read();
        const otherBefore = read(otherKey);
        const readWindows = () => query("SELECT * FROM session_windows ORDER BY session_id");
        const windowsBefore = readWindows();
        if (rejectSuggestions) {
          artifactDeletionFault.enable();
        }
        const owner = nativeOwner();
        const counter = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(database.db),
          ["inventory"],
          (sql) =>
            /^select "name" from "sqlite_schema" where "type" = \? and "name" in \(/i.test(sql)
              ? "inventory"
              : null,
        );
        try {
          const deletion = deleteWindows
            ? owner.run(() =>
                mutate({
                  removals: [{ sessionKey, deleteOwnedWindows: true }],
                  skipMaintenance: true,
                }),
              )
            : owner.run(() => deleteEntry({ agentId: "main" }));
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
          artifactDeletionFault.disable();
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
              query(
                "SELECT name FROM sqlite_schema WHERE name IN ('session_members', 'session_suggestions')",
              ),
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
      await write(reclaimedKey, entry);
      for (const survivorKey of survivorKeys.toReversed()) {
        await write(survivorKey, {
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
        });
      }
      const scope = {
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      };
      const database = openOpenClawAgentDatabase(scope);
      replaceTranscriptEventsSync(transcript(entry.sessionId, reclaimedKey), [retainedEvent]);
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
      expect(loadSessionEntry(scopeFor(reclaimedKey))).toBeUndefined();
      expect(readSurvivors()).toEqual(survivorsBefore);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(entry.sessionId),
      ).toEqual({ session_key: survivorKeys[0] });
      await expect(
        loadTranscriptEvents(transcript(entry.sessionId, survivorKeys[0])),
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
      await write(key, {
        sessionId: id,
        lifecycleRevision: `generation:${id}`,
        updatedAt: Date.now(),
        agentHarnessId: "native-test",
        delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to: room } }),
      });
      bindings.set(key, `thread:${key}`);
    }
    const siblingBefore = read(lowerKey);
    const bindingsBefore = new Map(bindings);
    const prepare = vi.fn(async () => {});
    const owner = nativeOwner({ prepare });
    const identities = [lowerKey, "lower-session"];
    const onInterrupt = vi.fn();
    const admission = await beginSessionEffect({
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
      expect(isSessionControllerWorkActive(storePath, identities)).toBe(true);
      expect(isCompetingSessionControllerWorkActive(storePath, identities)).toBe(true);
      await admission.run(async () => {
        expect(isCompetingSessionControllerWorkActive(storePath, identities)).toBe(false);
      });
    } finally {
      admission.release();
    }
  });

  it("honors identity guards and deletes ownership with or without recorded harness metadata", async () => {
    await seed(sessionKey, null);
    await seed(baseKey);
    const owner = nativeOwner();

    await expect(owner.run(() => deleteEntry({ expectedSessionId: null }))).resolves.toEqual({
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
      replaceTranscriptEventsSync(transcript(), events);
      const entryBefore = read();
      const afterCommit = vi.fn();
      const failure =
        phase === "owner preparation"
          ? "native session is supervised"
          : "injected session delete failure";
      if (phase === "SQLite transaction") {
        probe.admission(workerAdmission, (request, grant, callback) => {
          const facts = isRecord(request.facts) ? request.facts.publication : undefined;
          if (
            request.stage === "commit" &&
            isRecord(facts) &&
            facts.kind === "session-native-binding"
          ) {
            throw new Error(failure);
          }
          callback(request, grant);
        });
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
      expect(await loadTranscriptEvents(transcript())).toEqual(events);
      expect(bindings.get(sessionKey)).toBe(`thread:${sessionKey}`);
    },
  );

  it.each(["observer", "receipt cleanup"] as const)(
    "publishes committed deletion when %s fails",
    async (phase) => {
      await seed();
      const owner = nativeOwner();
      const failure = new Error("injected publication failure");
      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
      const file = statSync(target.path, { bigint: true });
      const listener = vi.fn(() => {
        if (phase === "observer") {
          throw failure;
        }
      });
      const unsubscribe = onSessionIdentityMutation(listener);
      if (phase === "receipt cleanup") {
        vi.spyOn(
          personalPublicationLifecycle,
          "preparePersonalGitHubSessionReceiptDeletion",
        ).mockResolvedValueOnce(async () => {
          throw failure;
        });
      }
      try {
        if (phase === "observer") {
          await expect(owner.run(() => removeNodes())).resolves.toMatchObject({
            removedSessionKeys: [sessionKey],
          });
        } else {
          await expect(owner.run(() => remove())).rejects.toBe(failure);
        }
        const event = { kind: "delete", previous: { sessionId, sessionKeys: [sessionKey] } };
        expect(listener).toHaveBeenCalledExactlyOnceWith(
          phase === "observer"
            ? expect.objectContaining(event)
            : {
                ...event,
                agentId: "main",
                databaseIdentity: `${file.dev}:${file.ino}`,
              },
        );
        expect(read()).toBeUndefined();
        expect(bindings.has(sessionKey)).toBe(false);
      } finally {
        unsubscribe();
      }
    },
  );

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
    const deletion = owner.run(() => removeNodes([baseKey, sessionKey]));
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
    await write(sessionKey, { sessionId: historicalId, updatedAt: Date.now() });
    expect(replaceTranscriptEventsSync(transcript(historicalId), [historicalEvent])).toBe(true);
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
    const deletion = owner.run(() => deleteEntry({ agentId: "main", archiveTranscript: true }));
    await expect(deletion).rejects.toThrow("harness owner changed");
    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.has(sessionKey)).toBe(true);
    expect(await loadTranscriptEvents(transcript(historicalId))).toEqual([historicalEvent]);
  });

  it.each(["entry replacement", "maintenance"] as const)(
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
        await mutate({
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
