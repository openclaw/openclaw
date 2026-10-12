import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import {
  createSessionEntryWithTranscript,
  prepareSessionEntryMutationDatabases,
} from "./session-accessor.entry-mutation.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  assertSessionEntryCreationPublication,
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

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
      await using preparation = prepareSessionEntryMutationDatabases(
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
    if (typeof databaseIdentity !== "string") {
      throw new Error("Expected a durable session database identity");
    }
    const key = "agent:main:creation-worker";
    using post = vi.spyOn(Worker.prototype, "postMessage");
    const alias = state.path("agent-alias");
    await fs.symlink(path.dirname(database.path), alias, "junction");
    const storePath = path.join(alias, path.basename(database.path));
    const cfg = { agents: { entries: { main: {} } }, session: { store: database.path } };
    await state.writeConfig(cfg);
    await using storagePreparation = prepareSessionEntryMutationDatabases(
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
    let assertCreation: () => void = () => {
      throw new Error("Creation has not bound its owner");
    };
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
    const owner = {
      actor: { type: "human" as const, id: "creator" },
      assignedBy: { type: "system" as const, id: "fixture" },
      assignedAt: 1,
    };
    try {
      const result = await createSessionEntryWithTranscript(
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
              assertSessionEntryCreationPublication(operation, {
                agentId: "main",
                sessionKey: key,
                paths: new Set([storePath]),
                databaseIdentity: "file:0:0",
              }),
            ).toThrow("Session creation publication owner is no longer current");
            prepared.bindCreation(operation);
            assertCreation = () =>
              assertSessionEntryCreationPublication(operation, {
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
      const writes = post.mock.calls.flatMap(([request]) => {
        if (
          !isRecord(request) ||
          request.type !== "execute" ||
          !(request.input instanceof Uint8Array)
        ) {
          return [];
        }
        const command: unknown = deserialize(request.input);
        return isRecord(command) &&
          typeof command.type === "string" &&
          command.type.startsWith("session.")
          ? [command.type]
          : [];
      });
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
      const firstUse = await createSessionEntryWithTranscript(
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
    expect(readExactSessionEntryRow(database, key)?.entry).toMatchObject({
      sessionId: "created",
      owner,
    });
    expect(readTranscriptStorageRows(database, "created")).toHaveLength(1);
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
      let assertCreation: () => void = () => {
        throw new Error("Creation has not bound its owner");
      };
      let closing: Promise<unknown> | undefined;
      const message =
        kind === "closed"
          ? "Session history database read was revoked"
          : "SQLite database file identity changed before existing-only open";
      try {
        await expect(
          createSessionEntryWithTranscript(
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
                  assertSessionEntryCreationPublication(operation, {
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
    const result = await createSessionEntryWithTranscript(
      { agentId: "main", storePath: database.path, sessionKey: "agent:main:rejected" },
      () => ({ ok: false, error: "rejected" }),
      { afterCommitted: followup },
    );
    expect(result).toEqual({ ok: false, phase: "entry", error: "rejected" });
    const invalid = await createSessionEntryWithTranscript(
      { agentId: "main", storePath: database.path, sessionKey: "agent:main:rejected" },
      () => ({ ok: true, entry: { sessionId: "", updatedAt: 1 } }),
      { afterCommitted: followup },
    );
    expect(invalid).toMatchObject({ ok: false, phase: "transcript" });
    expect(readTranscriptStorageRows(database, "")).toEqual([]);
    expect(followup).not.toHaveBeenCalled();
    expect(readExactSessionEntryRow(database, "agent:main:rejected")).toBeUndefined();
  });
});

it.each(["incognito", "maintenance", "alias replacement"] as const)(
  "retains valid native %s creation through follow-up",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey:
          kind === "incognito"
            ? "agent:main:dashboard:incognito-fixture"
            : kind === "maintenance"
              ? "agent:main:native-maintenance"
              : "agent:main:signal:group:NativeReplacement",
      };
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const alias = scope.sessionKey.toLowerCase();
      const oldSessionId = "native-replaced-session";
      if (kind === "alias replacement") {
        writeSessionEntry(database, alias, { sessionId: oldSessionId, updatedAt: 1 });
        ensureTranscriptHeader(
          database,
          { ...scope, sessionKey: alias, sessionId: oldSessionId },
          "/old",
        );
      }
      const schemaLease =
        kind !== "incognito" ? acquireStateDatabaseSchemaLease(database.path) : undefined;
      const maintenance = schemaLease
        ? createOpenClawDatabaseMaintenanceScope({
            schemaMaintenance: true,
            assertOwnerCurrent: () => schemaLease.assertCurrent(),
            assertDatabaseAccess: schemaLease.assertDatabaseAccess,
          })
        : undefined;
      let followed = false;
      const create = () =>
        createSessionEntryWithTranscript(
          scope,
          () => ({ ok: true, entry: { sessionId: "native-created", updatedAt: 1 } }),
          {
            afterCommitted: async (_entry, source) => {
              source.assertCurrent();
              expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId).toBe(
                "native-created",
              );
              await Promise.resolve();
              source.assertCurrent();
              followed = true;
            },
          },
        );
      try {
        const created = await (maintenance ? maintenance.run(create) : create());
        expect(created.ok).toBe(true);
        expect(followed).toBe(true);
        if (kind === "alias replacement") {
          expect(created).toMatchObject({ ok: true, sessionFile: scope.sessionKey });
          expect(readExactSessionEntryRow(database, alias)).toBeUndefined();
          expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId).toBe(
            "native-created",
          );
          expect(readTranscriptStorageRows(database, oldSessionId)).toEqual([]);
          expect(readTranscriptStorageRows(database, "native-created")).toHaveLength(1);
        }
      } finally {
        try {
          await maintenance?.close();
        } finally {
          schemaLease?.release();
        }
      }
    });
  },
);

it("adopts admitted Signal history and collaboration without host SQL, preserving a case-distinct Matrix sibling", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    using post = vi.spyOn(Worker.prototype, "postMessage");
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
    const transcript = readTranscriptStorageRows(database, original.sessionId);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable alias fixture");
    }
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
    const owner = {
      actor: { type: "human" as const, id: "adopter" },
      assignedBy: { type: "system" as const, id: "fixture" },
      assignedAt: 2,
    };
    let committed = false;
    let sourceHeld = false;
    const sql = observeHostDataSql();
    try {
      const result = await createSessionEntryWithTranscript(
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
    expect(readExactSessionEntryRow(database, alias)).toBeUndefined();
    expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject({
      ...original,
      owner,
      participants: [{ identity: { type: "agent", id: "peer" } }],
    });
    expect(readTranscriptStorageRows(database, original.sessionId)).toEqual(transcript);
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
        await createSessionEntryWithTranscript(
          { ...scope, sessionKey: matrixKey },
          ({ existingEntry }) => ({ ok: true, entry: existingEntry! }),
        )
      ).ok,
    ).toBe(true);
    expect(readExactSessionEntryRow(database, sibling)?.entry.sessionId).toBe("matrix-sibling");
    const commands = post.mock.calls.flatMap(([request]) => {
      if (
        !isRecord(request) ||
        request.type !== "execute" ||
        !(request.input instanceof Uint8Array)
      ) {
        return [];
      }
      const command: unknown = deserialize(request.input);
      return isRecord(command) ? [command.type] : [];
    });
    expect(commands).toContain("session.entries.replace");
    expect(commands).not.toContain("session.archives.preparePublication");
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
      const workspace = await repositories.create({
        agentId: "main",
        sessionKey: alias,
        url: "https://github.com/example/alias.git",
        assertCurrent: () => {},
      });
      const siblingWorkspace = await repositories.create({
        agentId: "other",
        sessionKey: alias,
        url: "https://github.com/example/sibling.git",
        assertCurrent: () => {},
      });
      writeSessionEntry(database, alias, original);
      ensureTranscriptHeader(
        database,
        { agentId: "main", sessionKey: alias, sessionId: original.sessionId },
        "/workspace",
      );
      const order: string[] = [];
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "core",
        source: "runtime",
        harness: {
          id: "alias-owner",
          label: "Alias fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused");
          },
          withSessionDeletion: async (params, run) => {
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
          },
        },
      });
      markPluginRegistryActive(registry);
      const stop = onSessionIdentityMutation((mutation) => {
        if (mutation.kind === "move") {
          order.push("published");
        }
      });
      const create = () =>
        withPluginRuntimeRegistryScope(registry, () =>
          createSessionEntryWithTranscript(
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
        expect(readExactSessionEntryRow(database, alias)).toBeUndefined();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject(original);
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
    writeSessionEntry(database, alias, original);
    ensureTranscriptHeader(
      database,
      { agentId: "main", sessionKey: alias, sessionId: original.sessionId },
      "/workspace",
    );
    const notified = vi.fn();
    let sourceAcquisitions = 0;
    let racedKey = alias;
    const create = () =>
      createSessionEntryWithTranscript(
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
    expect(readExactSessionEntryRow(database, alias)?.entry.label).toBe("concurrent");
    expect(readExactSessionEntryRow(database, sessionKey)).toBeUndefined();
    sourceAcquisitions = 0;
    racedKey = sessionKey;
    await expect(create()).rejects.toThrow("changed before replacement for " + sessionKey);
    expect(readExactSessionEntryRow(database, alias)?.entry.label).toBe("concurrent");
    expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("concurrent");
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
        const work = createSessionEntryWithTranscript(
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
        expect(readTranscriptStorageRows(database, "cleanup-header")).toHaveLength(1);
        expect(readExactSessionEntryRow(database, key)).toBeUndefined();
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
        createSessionEntryWithTranscript(
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
      expect(readTranscriptStorageRows(database, "failed-create")).toEqual([]);
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
    const header = readTranscriptStorageRows(database, "failed-create");
    expect(header).toHaveLength(1);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    expect(
      (
        await createSessionEntryWithTranscript(
          { agentId: "main", storePath: database.path, sessionKey },
          () => ({ ok: true, entry: { sessionId: "failed-create", updatedAt: 2 } }),
        )
      ).ok,
    ).toBe(true);
    const reopened = openOpenClawAgentDatabase({ agentId: "main", path: database.path });
    expect(readTranscriptStorageRows(reopened, "failed-create")).toEqual(header);
    expect(readExactSessionEntryRow(reopened, sessionKey)?.entry.sessionId).toBe("failed-create");
  });
});
