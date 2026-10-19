import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createNativeSessionCommitFinalizer } from "../../agents/harness/native-session/deletion-participant.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  ensureSessionGroupCatalog,
  readSessionGroupCatalog,
} from "../../gateway/session-group-catalog.js";
import { ensureSessionGroupRegistered } from "../../gateway/session-groups.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { acquireStateDatabaseSchemaLease } from "../../infra/gateway-state-owner.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  createSessionEntryWithTranscript as createEntry,
  prepareSessionEntryMutationDatabases as prepareDatabases,
} from "./session-accessor.entry-mutation.js";
import { withSqliteSessionDeletions } from "./session-accessor.sqlite-deletion.js";
import {
  assertSessionEntryCreationPublication as assertCreationOwner,
  readPreparedSessionEntryChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow as readEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readTranscriptStorageRows as transcriptRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

function ownerAssignment(id: string, assignedAt = 1) {
  return {
    actor: { type: "human" as const, id },
    assignedBy: { type: "system" as const, id: "fixture" },
    assignedAt,
  };
}

function unboundCreation(): never {
  throw new Error("Creation has not bound its owner");
}

function registerHarness(id: string, withSessionDeletion: AgentHarness["withSessionDeletion"]) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "core",
    source: "runtime",
    harness: {
      id,
      label: id,
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
      withSessionDeletion,
    },
  });
  markPluginRegistryActive(registry);
  return registry;
}

function seedAlias(
  database: Parameters<typeof writeSessionEntry>[0],
  sessionKey: string,
  entry: Parameters<typeof writeSessionEntry>[2],
  cwd = "/workspace",
) {
  const alias = sessionKey.toLowerCase();
  writeSessionEntry(database, alias, entry);
  ensureTranscriptHeader(
    database,
    { agentId: "main", sessionKey: alias, sessionId: entry.sessionId },
    cwd,
  );
}

function observePostedCommands(commands: string[]) {
  // oxlint-disable-next-line typescript/unbound-method -- call supplies the intercepted worker receiver.
  const nativePost = Worker.prototype.postMessage;
  return vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request,
    transferList,
  ) {
    let commandType: string | undefined;
    if (isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array) {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && typeof command.type === "string") {
        commandType = command.type;
      }
    }
    nativePost.call(this, request, transferList);
    if (commandType !== undefined) {
      commands.push(commandType);
    }
  });
}

it.each([false, true])(
  "prepares a new custom-store suffix only while absent (appeared=%s)",
  async (appeared) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("custom", "sessions.json");
      const basePath = path.join(path.dirname(storePath), "openclaw-agent.sqlite");
      const suffixPath = path.join(path.dirname(storePath), "openclaw-agent.ops.sqlite");
      const templatePath = state.statePath("ops-template.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: basePath });
      openOpenClawAgentDatabase({ agentId: "ops", path: templatePath });
      await closeOpenClawAgentDatabasesAsync();
      const existingBytes = await fs.readFile(templatePath);
      const ready = createDeferred();
      await using preparation = prepareDatabases(
        [
          {
            scope: { agentId: "ops", storePath, sessionKey: "agent:ops:new" },
            assertCurrent: () => {},
          },
        ],
        ready.promise,
      );
      try {
        if (appeared) {
          await fs.copyFile(templatePath, suffixPath);
        }
      } finally {
        ready.resolve();
      }
      if (appeared) {
        await expect(preparation.preparations[0]).rejects.toThrow(
          "lost its originally captured database target",
        );
        expect((await fs.readFile(suffixPath)).equals(existingBytes)).toBe(true);
      } else {
        const prepared = await preparation.preparations[0];
        expect(prepared?.execution).toBeDefined();
        prepared?.assertCurrent();
        expect((await fs.stat(suffixPath)).isFile()).toBe(true);
      }
    });
  },
);

it("creates through an admitted store alias with prepared facts and atomic ownership", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
    assert(typeof databaseIdentity === "string", "Expected a durable session database identity");
    const key = "agent:main:creation-worker";
    const commands: string[] = [];
    using _ = observePostedCommands(commands);
    const alias = state.path("agent-alias");
    await fs.symlink(path.dirname(database.path), alias, "junction");
    const storePath = path.join(alias, path.basename(database.path));
    const cfg = { agents: { entries: { main: {} } }, session: { store: database.path } };
    await state.writeConfig(cfg);
    await using storagePreparation = prepareDatabases(
      [{ scope: { agentId: "main", storePath, sessionKey: key }, assertCurrent: () => {} }],
      Promise.resolve(),
    );
    await storagePreparation.preparations[0];
    const prepared = await prepareSessionMutationFacts({
      cfg,
      agentId: "main",
      sessionKey: key,
      allowMissing: true,
    });
    let assertCreation: () => void = unboundCreation;
    runOpenClawAgentWriteTransaction(
      (db) => {
        writeSessionEntry(db, "agent:main:sibling", {
          sessionId: "sibling",
          label: "taken",
          updatedAt: 1,
          skillsSnapshot: { prompt: "unrelated".repeat(1024), skills: [] },
        });
      },
      { agentId: database.agentId, path: database.path },
    );
    const env = { ...process.env };
    const originalStateDir = env.OPENCLAW_STATE_DIR;
    const order: string[] = [];
    const publications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
    const stopProjection = sessionChanges.subscribeProjection((change) => {
      if ("sessionKey" in change && change.sessionKey === key) {
        publications.push(readPreparedSessionEntryChange(change, key));
      }
    });
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === key) {
        order.push(order.includes("committed") ? "published" : "header");
      }
    });
    const sql = observeHostDataSql();
    const owner = ownerAssignment("creator");
    try {
      const result = await createEntry(
        { agentId: "main", storePath, sessionKey: key, env },
        async (snapshot) => {
          expect(snapshot.existingEntry).toBeUndefined();
          expect(snapshot.labelInUse).toBe(false);
          env.OPENCLAW_STATE_DIR = state.statePath("changed-during-preparation");
          assertCreation();
          await Promise.resolve();
          assertCreation();
          expect(snapshot.labelInUse).toBe(false);
          return {
            ok: true,
            entry: { sessionId: "created", updatedAt: 2, category: "Created", label: "available" },
          };
        },
        {
          label: "available",
          bindCreation: (operation) => {
            expect(() =>
              assertCreationOwner(operation, {
                agentId: "main",
                sessionKey: key,
                paths: new Set([storePath]),
                databaseIdentity: "file:0:0",
              }),
            ).toThrow("Session creation publication owner is no longer current");
            prepared.bindCreation(operation);
            assertCreation = () =>
              assertCreationOwner(operation, {
                agentId: "main",
                sessionKey: key,
                paths: new Set([database.path]),
                databaseIdentity: `file:${databaseIdentity}`,
              });
            assertCreation();
          },
          commitGuard: () => {
            if (!order.includes("committed")) {
              expect(prepared.readCurrent(cfg).target).toBeNull();
            }
          },
          cwd: "/workspace",
          resolveOwnerAssignment: () => owner,
          onLifecycleCommitted: () => {
            order.push("committed");
          },
          afterCommitted: async (entry, source) => {
            expect(order).toEqual(["committed", "published"]);
            expect(source.env.OPENCLAW_STATE_DIR).toBe(originalStateDir);
            source.assertCurrent();
            assertCreation();
            await ensureSessionGroupRegistered(entry.category!, source.env, source.assertCurrent);
            source.assertCurrent();
            order.push("registered");
          },
        },
      );
      expect(result).toMatchObject({
        ok: true,
        entry: { sessionId: "created", label: "available" },
      });
      const writes = commands.filter((command) => command.startsWith("session."));
      expect(writes).toEqual(["session.entries.replace"]);
      expect(assertCreation).toThrow("Session creation publication owner is no longer current");
      expect(publications).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining({
            sessionId: "created",
            category: "Created",
            label: "available",
            owner,
          }),
          source: expect.objectContaining({
            identity: expect.any(String),
            revision: expect.any(Number),
          }),
        }),
      ]);
      const firstUse = await createEntry(
        {
          agentId: "main",
          storePath: state.statePath("first-use.sqlite"),
          sessionKey: "agent:main:first-use",
        },
        () => ({ ok: true, entry: { sessionId: "first-use", updatedAt: 1 } }),
      );
      expect(firstUse.ok).toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      prepared.release();
      sql.restore();
      stopProjection();
      stop();
    }
    expect(order).toEqual(["committed", "published", "registered"]);
    expect(readEntry(database, key)?.entry).toMatchObject({
      sessionId: "created",
      owner,
    });
    expect(transcriptRows(database, "created")).toHaveLength(1);
    await ensureSessionGroupCatalog();
    expect(readSessionGroupCatalog().groups.map(({ name }) => name)).toContain("Created");
  });
});

it.each(["replaced", "closed"] as const)(
  "rejects a %s creation owner after asynchronous preparation",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:stale-creation";
      const alias = state.path("agent-alias");
      await fs.symlink(path.dirname(database.path), alias, "junction");
      const storePath = path.join(alias, path.basename(database.path));
      let assertCreation: () => void = unboundCreation;
      let closing: Promise<unknown> | undefined;
      const message =
        kind === "closed"
          ? "Session history database read was revoked"
          : "SQLite database file identity changed before existing-only open";
      try {
        await expect(
          createEntry(
            { agentId: "main", storePath, sessionKey },
            async () => {
              await Promise.resolve();
              assertCreation();
              if (kind === "closed") {
                closing = closeOpenClawAgentDatabaseByPathAsync(storePath);
              } else {
                const replacement = state.path("replacement");
                await fs.mkdir(replacement);
                await fs.writeFile(path.join(replacement, path.basename(database.path)), "");
                await fs.rm(alias, { recursive: true });
                await fs.symlink(replacement, alias, "junction");
              }
              expect(assertCreation).toThrow(message);
              return { ok: true, entry: { sessionId: "must-not-publish", updatedAt: 1 } };
            },
            {
              bindCreation: (operation) => {
                assertCreation = () =>
                  assertCreationOwner(operation, {
                    agentId: "main",
                    sessionKey,
                    paths: new Set([storePath, database.path]),
                  });
                assertCreation();
              },
            },
          ),
        ).rejects.toThrow(message);
        expect(assertCreation).toThrow("Session creation publication owner is no longer current");
      } finally {
        await closing;
      }
    });
  },
);

it("does not initialize a transcript or invoke follow-up when creation rejects", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const followup = vi.fn();
    const result = await createEntry(
      { agentId: "main", storePath: database.path, sessionKey: "agent:main:rejected" },
      () => ({ ok: false, error: "rejected" }),
      { afterCommitted: followup },
    );
    expect(result).toEqual({ ok: false, phase: "entry", error: "rejected" });
    const invalid = await createEntry(
      { agentId: "main", storePath: database.path, sessionKey: "agent:main:rejected" },
      () => ({ ok: true, entry: { sessionId: "", updatedAt: 1 } }),
      { afterCommitted: followup },
    );
    expect(invalid).toMatchObject({ ok: false, phase: "transcript" });
    expect(transcriptRows(database, "")).toEqual([]);
    expect(followup).not.toHaveBeenCalled();
    expect(readEntry(database, "agent:main:rejected")).toBeUndefined();
  });
});

it.each(["maintenance", "alias replacement"] as const)(
  "retains valid native %s creation through follow-up",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        sessionKey:
          kind === "maintenance"
            ? "agent:main:native-maintenance"
            : "agent:main:signal:group:NativeReplacement",
      };
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const alias = scope.sessionKey.toLowerCase();
      const oldSessionId = "native-replaced-session";
      if (kind === "alias replacement") {
        seedAlias(database, scope.sessionKey, { sessionId: oldSessionId, updatedAt: 1 }, "/old");
      }
      const schemaLease = acquireStateDatabaseSchemaLease(database.path);
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => schemaLease.assertCurrent(),
        assertDatabaseAccess: schemaLease.assertDatabaseAccess,
      });
      let followed = false;
      const create = () =>
        createEntry(
          scope,
          () => ({ ok: true, entry: { sessionId: "native-created", updatedAt: 1 } }),
          {
            afterCommitted: async (_entry, source) => {
              source.assertCurrent();
              expect(readEntry(database, scope.sessionKey)?.entry.sessionId).toBe("native-created");
              await Promise.resolve();
              source.assertCurrent();
              followed = true;
            },
          },
        );
      try {
        const created = await maintenance.run(create);
        expect(created.ok).toBe(true);
        expect(followed).toBe(true);
        if (kind === "alias replacement") {
          expect(created).toMatchObject({ ok: true, sessionFile: scope.sessionKey });
          expect(readEntry(database, alias)).toBeUndefined();
          expect(readEntry(database, scope.sessionKey)?.entry.sessionId).toBe("native-created");
          expect(transcriptRows(database, oldSessionId)).toEqual([]);
          expect(transcriptRows(database, "native-created")).toHaveLength(1);
        }
      } finally {
        try {
          await maintenance.close();
        } finally {
          schemaLease.release();
        }
      }
    });
  },
);

it("adopts admitted Signal history and collaboration without host SQL, preserving a case-distinct Matrix sibling", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const commands: string[] = [];
    using _ = observePostedCommands(commands);
    const sessionKey = "agent:main:signal:group:AbC";
    const alias = sessionKey.toLowerCase();
    const scope = { agentId: "main", storePath: database.path, sessionKey: alias };
    const original = {
      sessionId: "signal-history",
      lifecycleRevision: "retained-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
    };
    writeSessionEntry(database, alias, original);
    replaceTranscriptEventsSync({ ...scope, sessionId: original.sessionId }, [
      { type: "session", id: original.sessionId, version: 3, cwd: "/original" },
      {
        type: "message",
        id: "kept",
        message: { role: "user", content: "Preserve text.\r\n  And spacing." },
      },
    ]);
    recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 1 });
    addSessionMember(scope, { identityId: "member", addedBy: "creator", addedAt: 1 });
    const transcript = transcriptRows(database, original.sessionId);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    assert(typeof identity === "string", "Expected durable alias fixture");
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: "file:" + identity,
      sessionKey: alias,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const targetSharing = retainPreparedSessionSharingFacts({
      databaseIdentity: "file:" + identity,
      sessionKey,
      entry: undefined,
      membership: new Set(),
    });
    const moves: string[][] = [];
    const stop = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "move") {
        moves.push([...mutation.previous.sessionKeys, ...mutation.current.sessionKeys]);
      }
    });
    const owner = ownerAssignment("adopter", 2);
    let committed = false;
    let sourceHeld = false;
    const sql = observeHostDataSql();
    try {
      const result = await createEntry(
        { ...scope, sessionKey },
        ({ existingEntry, targetEntry }) => {
          expect(existingEntry).toMatchObject(original);
          expect(targetEntry).toBeUndefined();
          return { ok: true, entry: { ...existingEntry!, label: "adopted" } };
        },
        {
          resolveOwnerAssignment: () => owner,
          withCommit: async (run) => {
            sourceHeld = true;
            try {
              return await run(() => {
                expect(sourceHeld).toBe(true);
              });
            } finally {
              sourceHeld = false;
            }
          },
          onLifecycleCommitted: () => {
            committed = true;
          },
          afterCommitted: async (_entry, source) => {
            source.assertCurrent();
            expect(sourceHeld).toBe(true);
            expect(committed).toBe(true);
            expect(moves).toEqual([[alias, sessionKey]]);
            expect(sharing.readCurrent()?.entry).toBeUndefined();
            expect(targetSharing.readCurrent()).toBeUndefined();
          },
        },
      );
      expect(result).toMatchObject({ ok: true, sessionFile: sessionKey });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      stop();
      sharing.release();
      targetSharing.release();
    }
    expect(readEntry(database, alias)).toBeUndefined();
    expect(readEntry(database, sessionKey)?.entry).toMatchObject({
      ...original,
      owner,
      participants: [{ identity: { type: "agent", id: "peer" } }],
    });
    expect(transcriptRows(database, original.sessionId)).toEqual(transcript);
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get(original.sessionId),
    ).toEqual({ session_key: sessionKey });
    expect(
      listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
    ).toEqual(["member"]);

    const matrixKey = "agent:main:matrix:group:!Room:example.org";
    const sibling = matrixKey.toLowerCase();
    writeSessionEntry(database, matrixKey, { sessionId: "matrix-target", updatedAt: 1 });
    writeSessionEntry(database, sibling, { sessionId: "matrix-sibling", updatedAt: 2 });
    expect(
      (
        await createEntry({ ...scope, sessionKey: matrixKey }, ({ existingEntry }) => ({
          ok: true,
          entry: existingEntry!,
        }))
      ).ok,
    ).toBe(true);
    expect(readEntry(database, sibling)?.entry.sessionId).toBe("matrix-sibling");
    expect(commands).toContain("session.entries.replace");
    expect(commands).not.toContain("session.archives.preparePublication");
  });
});

it("creates with prepared native finalizers in the worker and settles them after commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:signal:group:TypedNative";
    const alias = sessionKey.toLowerCase();
    const original = {
      sessionId: "typed-native-alias",
      updatedAt: 1,
      agentHarnessId: "typed-owner",
    };
    seedAlias(database, sessionKey, original);
    const finalized = vi.fn(() => {
      expect(database.db.isTransaction).toBe(false);
    });
    const rollback = vi.fn();
    const registry = registerHarness("typed-owner", async (_params, run) =>
      run(createNativeSessionCommitFinalizer({ commit: finalized, rollback })),
    );
    const sql = observeHostDataSql();
    try {
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        withSqliteSessionDeletions(
          resolveSqliteScope({ agentId: "main", storePath: database.path, sessionKey: alias }),
          [{ sessionKey: alias, entry: original }],
          () =>
            createEntry(
              { agentId: "main", storePath: database.path, sessionKey },
              ({ existingEntry }) => ({ ok: true, entry: existingEntry! }),
              {
                afterCommitted: async () => {
                  expect(finalized).toHaveBeenCalledTimes(1);
                },
              },
            ),
        ),
      );
      expect(result.ok).toBe(true);
      expect(sql.queries).toEqual([]);
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(rollback).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      markPluginRegistryRetired(registry);
    }
    expect(readEntry(database, alias)).toBeUndefined();
    expect(readEntry(database, sessionKey)?.entry.sessionId).toBe(original.sessionId);
    expect(transcriptRows(database, original.sessionId)).toHaveLength(1);
  });
});

it.each([false, true])(
  "keeps alias creation committed when legacy cleanup fails (%s)",
  async (reject) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:signal:group:Native";
      const alias = sessionKey.toLowerCase();
      const original = { sessionId: "native-alias", updatedAt: 1, agentHarnessId: "alias-owner" };
      const repositories = createSessionRepositoryWorkspaceStore();
      const workspaceFor = (agentId: string, name: string) =>
        repositories.create({
          agentId,
          sessionKey: alias,
          url: `https://github.com/example/${name}.git`,
          assertCurrent: () => {},
        });
      const workspace = await workspaceFor("main", "alias");
      const siblingWorkspace = await workspaceFor("other", "sibling");
      seedAlias(database, sessionKey, original);
      const order: string[] = [];
      const registry = registerHarness("alias-owner", async (params, run) => {
        params.assertCurrent();
        expect(params.sessionKey).toBe(alias);
        expect(database.db.isTransaction).toBe(false);
        order.push("prepare");
        const result = await run({
          commit: () => {
            expect(database.db.isTransaction).toBe(false);
            order.push("native");
            if (reject) {
              throw new Error("native alias failure");
            }
          },
          rollback: () => {
            order.push("rollback");
          },
        });
        order.push("release");
        return result;
      });
      const stop = onSessionIdentityMutation((mutation) => {
        if (mutation.kind === "move") {
          order.push("published");
        }
      });
      const create = () =>
        withPluginRuntimeRegistryScope(registry, () =>
          createEntry(
            { agentId: "main", storePath: database.path, sessionKey },
            ({ existingEntry }) => ({ ok: true, entry: existingEntry! }),
            {
              onLifecycleCommitted: () => {
                order.push("committed");
              },
              afterCommitted: async (_entry, source) => {
                source.assertCurrent();
                await Promise.resolve();
                source.assertCurrent();
                expect(order).toEqual(["prepare", "native", "committed", "published"]);
                order.push("followup");
              },
            },
          ),
        );
      try {
        expect((await create()).ok).toBe(true);
        expect(order).toEqual([
          "prepare",
          "native",
          "committed",
          "published",
          "followup",
          "release",
        ]);
        expect(readEntry(database, alias)).toBeUndefined();
        expect(readEntry(database, sessionKey)?.entry).toMatchObject(original);
        expect(await repositories.get(workspace.workspaceId)).toBeUndefined();
        expect(await repositories.get(siblingWorkspace.workspaceId)).toEqual(siblingWorkspace);
      } finally {
        stop();
        markPluginRegistryRetired(registry);
      }
    });
  },
);

it("checks both alias and canonical target after source custody is acquired", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:signal:group:Race";
    const alias = sessionKey.toLowerCase();
    const original = { sessionId: "alias-race", updatedAt: 1 };
    seedAlias(database, sessionKey, original);
    const notified = vi.fn();
    let sourceAcquisitions = 0;
    let racedKey = alias;
    const create = () =>
      createEntry(
        { agentId: "main", storePath: database.path, sessionKey },
        ({ existingEntry }) => ({ ok: true, entry: existingEntry! }),
        {
          withCommit: async (run) => {
            // Header initialization precedes replacement planning; mutate only at
            // final source acquisition, after the replacement snapshot exists.
            if (++sourceAcquisitions === 2) {
              writeSessionEntry(database, racedKey, { ...original, label: "concurrent" });
            }
            return run(() => {});
          },
          onLifecycleCommitted: notified,
          afterCommitted: async () => {
            notified();
          },
        },
      );
    await expect(create()).rejects.toThrow("changed before replacement for " + alias);
    expect(readEntry(database, alias)?.entry.label).toBe("concurrent");
    expect(readEntry(database, sessionKey)).toBeUndefined();
    sourceAcquisitions = 0;
    racedKey = sessionKey;
    await expect(create()).rejects.toThrow("changed before replacement for " + sessionKey);
    expect(readEntry(database, alias)?.entry.label).toBe("concurrent");
    expect(readEntry(database, sessionKey)?.entry.label).toBe("concurrent");
    expect(notified).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "preserves initialized header facts when cleanup fails (unknown=%s)",
  async (unknown) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const key = "agent:main:signal:group:Cleanup";
      writeSessionEntry(database, key.toLowerCase(), {
        sessionId: "alias-cleanup-header",
        updatedAt: 1,
      });
      const replacements = await import("./session-accessor.sqlite-replacement-worker.js");
      const { SqliteWorkerError } = await import("../../infra/sqlite-worker-contract.js");
      const failure = new AggregateError([
        new Error("Independent cleanup failure"),
        unknown
          ? new SqliteWorkerError("Header cleanup lost native settlement", "outcome-unknown")
          : new Error("Ordinary initialized-header cleanup failure"),
      ]);
      const initialize = replacements.initializeSessionTranscriptInWorker;
      const interception = vi
        .spyOn(replacements, "initializeSessionTranscriptInWorker")
        .mockImplementation(async (...args) => {
          await initialize(...args);
          throw failure;
        });
      const create = vi.fn(() => ({
        ok: true as const,
        entry: { sessionId: "cleanup-header", updatedAt: 1 },
      }));
      const committed = vi.fn();
      try {
        const work = createEntry(
          { agentId: "main", storePath: database.path, sessionKey: key },
          create,
          { onLifecycleCommitted: committed },
        );
        if (unknown) {
          await expect(work).rejects.toBe(failure);
        } else {
          await expect(work).resolves.toMatchObject({ ok: false, phase: "transcript" });
        }
        expect(create).toHaveBeenCalledOnce();
        expect(interception).toHaveBeenCalledOnce();
        expect(committed).not.toHaveBeenCalled();
        expect(transcriptRows(database, "cleanup-header")).toHaveLength(1);
        expect(readEntry(database, key)).toBeUndefined();
      } finally {
        interception.mockRestore();
      }
    });
  },
);

it("rolls back a failed fresh entry and recovers a previously committed standalone header", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:failed-create";
    const committed = vi.fn();
    const published = vi.fn();
    const stop = sessionChanges.subscribe(published);
    try {
      await expect(
        createEntry(
          { agentId: "main", storePath: database.path, sessionKey },
          () => ({
            ok: true,
            entry: {
              sessionId: "failed-create",
              updatedAt: 1,
              parentSessionKey: "AGENT:main:parent",
            },
          }),
          {
            onLifecycleCommitted: committed,
            afterCommitted: async () => {
              committed();
            },
          },
        ),
      ).rejects.toThrow("non-canonical session key");
      expect(committed).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      expect(transcriptRows(database, "failed-create")).toEqual([]);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toBeUndefined();
    } finally {
      stop();
    }
    ensureTranscriptHeader(
      database,
      { agentId: "main", sessionKey, sessionId: "failed-create" },
      "/old-process",
    );
    const header = transcriptRows(database, "failed-create");
    expect(header).toHaveLength(1);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    expect(
      (
        await createEntry({ agentId: "main", storePath: database.path, sessionKey }, () => ({
          ok: true,
          entry: { sessionId: "failed-create", updatedAt: 2 },
        }))
      ).ok,
    ).toBe(true);
    const reopened = openOpenClawAgentDatabase({ agentId: "main", path: database.path });
    expect(transcriptRows(reopened, "failed-create")).toEqual(header);
    expect(readEntry(reopened, sessionKey)?.entry.sessionId).toBe("failed-create");
  });
});
