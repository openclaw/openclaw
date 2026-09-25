import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  writeSessionEntry,
  deleteSessionEntryRows,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import * as sharingKernel from "../config/sessions/session-sharing-store.kernel.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOpenIncognitoAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  authorizePreparedSessionMutation,
  resolveSessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const unavailableMessage =
  "Session access facts are unavailable; retry after session storage is ready.";

it.each([false, true])(
  "refuses prepared authorization after same-inode birthtime replacement (registered=%s)",
  async (registered) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("sharing-birthtime.sqlite");
      const cfg = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      const sessionKey = "agent:main:birthtime-replacement";
      const scope = { agentId: "main", storePath, sessionKey };
      replaceSessionEntrySync(scope, {
        sessionId: "original",
        lifecycleRevision: "original-lifecycle",
        updatedAt: 1,
        visibility: "read-only",
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: "creator" },
      });
      await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
      const prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      const client = sharingPolicyClient({
        user: "requester",
        scopes: ["operator.read", "operator.write"],
      });
      const policy = { ...cfg.gateway!.roles!.definitions.view!, sandbox: "required" as const };
      const authorize = () =>
        authorizePreparedSessionMutation(
          { cfg, client, sessionKey, agentId: "main" },
          prepared.readCurrent(cfg),
          { policy, aliases: new Set(["requester"]) },
        );
      const original = fs.statSync(storePath, { bigint: true });
      const statSync = fs.statSync;
      let replaced = false;
      const stat = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
        const file = statSync(...args);
        if (replaced && String(args[0]) === storePath && file && "birthtimeNs" in file) {
          file.birthtimeNs = original.birthtimeNs + 1n;
        }
        return file;
      });
      try {
        syncBuiltinESMExports();
        expect(authorize()).toBeNull();
        replaced = true;
        const replacement = fs.statSync(storePath, { bigint: true });
        expect([replacement.dev, replacement.ino]).toEqual([original.dev, original.ino]);
        expect(replacement.birthtimeNs).not.toBe(original.birthtimeNs);
        expect(() =>
          assertExistingDatabaseIdentity(
            storePath,
            `file:${original.dev}:${original.ino}`,
            original.birthtimeNs.toString(),
          ),
        ).toThrow("SQLite database file identity changed before existing-only open");
        if (registered) {
          registerOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
        }
        expect(authorize).toThrow(unavailableMessage);
      } finally {
        stat.mockRestore();
        syncBuiltinESMExports();
        prepared.release();
      }
    });
  },
);

it("refuses a worker sharing result whose captured birthtime differs from its retained source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("sharing-worker-birthtime.sqlite");
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    const sessionKey = "agent:main:worker-birthtime";
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey },
      { sessionId: "original", updatedAt: 1 },
    );
    const file = fs.statSync(storePath, { bigint: true });
    const readEntries = sessionEntryReads.readSessionEntriesFromStoreInWorker;
    const observed: Array<Awaited<ReturnType<typeof readEntries>>["databaseIdentity"]> = [];
    const reader = vi
      .spyOn(sessionEntryReads, "readSessionEntriesFromStoreInWorker")
      .mockImplementation(async (input) => {
        const loaded = await readEntries(input);
        if (input.projection !== "sharing") {
          return loaded;
        }
        observed.push(loaded.databaseIdentity);
        return loaded.databaseIdentity
          ? {
              ...loaded,
              databaseIdentity: {
                ...loaded.databaseIdentity,
                birthtime: (file.birthtimeNs + 1n).toString(),
              },
            }
          : loaded;
      });
    let prepared: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
    try {
      await expect(
        prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" }).then((read) => {
          prepared = read;
          return read;
        }),
      ).rejects.toThrow(unavailableMessage);
      expect(observed).toEqual([
        expect.objectContaining({
          identity: `${file.dev}:${file.ino}`,
          filename: storePath,
          birthtime: file.birthtimeNs.toString(),
          incarnation: expect.any(String),
        }),
      ]);
    } finally {
      prepared?.release();
      reader.mockRestore();
    }
  });
});

it.each([
  ...(["same", "unrelated", "remove", "reassignment", "ABA", "unknown", "rollback"] as const).map(
    (change) => ({ change, location: "shared" }),
  ),
  ...(["same", "remove", "reassignment"] as const).map((change) => ({
    change,
    location: "canonical",
  })),
])(
  "retains only unchanged $location sharing sources after a $change registry publication",
  async ({ change, location }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const canonical = location === "canonical";
      const storePath = canonical
        ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : state.statePath("shared.sqlite");
      const registration = { agentId: "main", path: storePath, env: state.env };
      openOpenClawAgentDatabase(registration);
      const cfg: OpenClawConfig = canonical
        ? { agents: { entries: { main: {} } } }
        : { agents: { entries: { ops: {} } }, session: { store: storePath } };
      const agentId = canonical ? "main" : "ops";
      const target = { agentId, sessionKey: `agent:${agentId}:registry-sharing` };
      replaceSessionEntrySync(
        { ...target, storePath },
        {
          sessionId: "registry-sharing",
          lifecycleRevision: "first",
          updatedAt: 1,
        },
      );
      const prepared = await prepareSessionMutationFacts({ cfg, ...target });
      try {
        if (change === "unknown") {
          sessionChanges.emit({ all: true, scope: "stores" });
        } else if (change === "unrelated") {
          openOpenClawAgentDatabase({ agentId: "neighbor", env: state.env });
        } else if (change === "same") {
          registerOpenClawAgentDatabase(registration);
        } else if (change === "rollback") {
          expect(() =>
            runOpenClawStateWriteTransaction(
              () => {
                unregisterOpenClawAgentDatabase(registration);
                throw new Error("Synthetic registry rollback");
              },
              { env: state.env },
            ),
          ).toThrow("Synthetic registry rollback");
        } else if (change === "reassignment") {
          registerOpenClawAgentDatabase({ ...registration, agentId: "other" });
        } else {
          unregisterOpenClawAgentDatabase(registration);
          if (change === "ABA") {
            registerOpenClawAgentDatabase(registration);
          }
        }
        if (change === "same" || change === "unrelated" || change === "rollback") {
          expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("registry-sharing");
        } else {
          expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
        }
      } finally {
        prepared.release();
      }
    });
  },
);

it("does not discover registry-only retired stores outside captured roots", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("external-retired.sqlite");
    const registration = { agentId: "retired", path: storePath, env: state.env };
    openOpenClawAgentDatabase(registration);
    const target = { agentId: "retired", sessionKey: "agent:retired:external" };
    replaceSessionEntrySync(
      { ...target, storePath },
      { sessionId: "external-retired", lifecycleRevision: "first", updatedAt: 1 },
    );
    const cfg = { agents: { entries: { main: {} } } };
    const prepared = await prepareSessionMutationFacts({ cfg, ...target, allowMissing: true });
    try {
      expect(prepared.readCurrent(cfg).target).toBeNull();
      unregisterOpenClawAgentDatabase(registration);
      expect(prepared.readCurrent(cfg).target).toBeNull();
    } finally {
      prepared.release();
    }
  });
});

it.each([false, true])(
  "retains missing incognito identity across first birth and rollback (warm: %s)",
  async (warm) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      const sessionKey = "agent:main:dashboard:incognito-negative";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      const options = { agentId: "main", path: storePath };
      if (warm) {
        openOpenClawAgentDatabase(options);
      }
      const sql = observeHostDataSql(state.env);
      const read = await prepareSessionMutationFacts({
        cfg,
        sessionKey,
        agentId: "main",
        allowMissing: true,
      }).finally(sql.restore);
      const assertWithoutSql = (action: () => void) => {
        const observation = observeHostDataSql(state.env);
        try {
          action();
          for (const call of observation.calls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          observation.restore();
        }
      };
      try {
        expect(read.readCurrent(cfg).target).toBeNull();
        expect(read.storageTarget).toEqual({
          agentId: "main",
          canonicalKey: sessionKey,
          storePath,
        });
        expect(Boolean(getOpenIncognitoAgentDatabase("main", storePath))).toBe(warm);
        for (const call of sql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
        openOpenClawAgentDatabase(options);
        assertWithoutSql(() => expect(read.readCurrent(cfg).target).toBeNull());
        const entry: SessionEntry = {
          sessionId: "incognito-created",
          lifecycleRevision: "created",
          updatedAt: 1,
          incognito: true,
        };
        const rollback = new Error("roll back incognito creation");
        expect(() =>
          runOpenClawAgentWriteTransaction((database) => {
            writeSessionEntry(database, sessionKey, entry);
            assertWithoutSql(() => expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage));
            throw rollback;
          }, options),
        ).toThrow(rollback);
        assertWithoutSql(() => expect(read.readCurrent(cfg).target).toBeNull());
        replaceSessionEntrySync({ agentId: "main", sessionKey, storePath }, entry);
        assertWithoutSql(() => expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage));
      } finally {
        read.release();
        read.release();
      }
      expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
    });
  },
);

it("never treats a failed incognito sharing projection as absence, and repairs on committed writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const sessionKey = "agent:main:dashboard:incognito-projection-failure";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { agentId: "main", sessionKey, storePath };
    const options = { agentId: "main", path: storePath };
    const read = await prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    });
    const entry: SessionEntry = {
      sessionId: "projection-session",
      lifecycleRevision: "projection-generation",
      updatedAt: 1,
      incognito: true,
    };
    const projectionFailure = new Error("Synthetic sharing projection failure");
    const members = vi.spyOn(sharingKernel, "listSessionMembersInDatabase");
    try {
      members.mockImplementationOnce(() => {
        throw projectionFailure;
      });
      const rollback = new Error("Rollback failed projection");
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          writeSessionEntry(database, sessionKey, entry);
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(read.readCurrent(cfg).target).toBeNull();
      members.mockImplementationOnce(() => {
        throw projectionFailure;
      });
      replaceSessionEntrySync(scope, entry);
      expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
      await expect(
        prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main", allowMissing: true }).then(
          (fresh) => {
            fresh.release();
            return fresh;
          },
        ),
      ).rejects.toThrow(unavailableMessage);
      replaceSessionEntrySync(scope, { ...entry, updatedAt: 2 });
      const repaired = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      try {
        expect(repaired.readCurrent(cfg).target.entry.sessionId).toBe(entry.sessionId);
      } finally {
        repaired.release();
      }
      runOpenClawAgentWriteTransaction(
        (database) => deleteSessionEntryRows(database, sessionKey),
        options,
      );
      const removed = await prepareSessionMutationFacts({
        cfg,
        sessionKey,
        agentId: "main",
        allowMissing: true,
      });
      try {
        expect(removed.readCurrent(cfg).target).toBeNull();
      } finally {
        removed.release();
      }
    } finally {
      read.release();
      members.mockRestore();
    }
  });
});

it("rejects an incognito row published before a prepared negative read is consumed", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const sessionKey = "agent:main:dashboard:incognito-capture-race";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const pending = prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "competing-incognito-session",
        updatedAt: 1,
        incognito: true,
      },
    );
    const read = await pending;
    try {
      expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      read.release();
    }
  });
});

it.each([false, true])(
  "never adopts an incognito replacement after retirement (born: %s)",
  async (born) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const sessionKey = "agent:main:dashboard:incognito-retired-negative";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      const options = { agentId: "main", path: storePath };
      const read = await prepareSessionMutationFacts({
        cfg,
        sessionKey,
        agentId: "main",
        allowMissing: true,
      });
      try {
        if (born) {
          openOpenClawAgentDatabase(options);
          expect(read.readCurrent(cfg).target).toBeNull();
        }
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
        openOpenClawAgentDatabase(options);
        expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
        const fresh = await prepareSessionMutationFacts({
          cfg,
          sessionKey,
          agentId: "main",
          allowMissing: true,
        });
        try {
          expect(fresh.readCurrent(cfg).target).toBeNull();
        } finally {
          fresh.release();
        }
      } finally {
        read.release();
      }
    });
  },
);

it("refuses a missing incognito fact while the exact resource owner is closing", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const sessionKey = "agent:main:dashboard:incognito-closing-negative";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const revoked = createDeferredCore();
    const resume = createDeferredCore();
    const unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: storePath,
      revoke: () => revoked.resolve(),
      close: () => resume.promise,
    });
    const closing = closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
    try {
      await revoked.promise;
      await expect(
        prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main", allowMissing: true }),
      ).rejects.toThrow(unavailableMessage);
    } finally {
      resume.resolve();
      await closing;
      unregister();
    }
  });
});

it.each(["durable", "incognito"] as const)(
  "keeps %s sharing facts current before observers without SQL in retained assertions",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const sessionKey =
        kind === "incognito" ? "agent:main:dashboard:incognito-sharing" : "agent:main:sharing";
      const storePath =
        kind === "incognito"
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })
          : undefined;
      const databasePath = storePath ?? resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const scope = { agentId: "main", sessionKey, ...(storePath ? { storePath } : {}) };
      const entry: SessionEntry = {
        sessionId: "sharing-session",
        lifecycleRevision: "sharing-generation",
        updatedAt: 1,
        visibility: "read-only",
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: "creator" },
        ...(kind === "incognito" ? { incognito: true } : {}),
      };
      replaceSessionEntrySync(scope, entry);
      await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
      const client = sharingPolicyClient({
        user: "requester",
        scopes: kind === "incognito" ? ["operator.admin"] : ["operator.read", "operator.write"],
      });
      const policy = { ...cfg.gateway!.roles!.definitions.view!, sandbox: "required" as const };
      const authorize = (read: Awaited<ReturnType<typeof prepareSessionMutationFacts>>) =>
        authorizePreparedSessionMutation(
          { cfg, client, sessionKey, agentId: "main" },
          read.readCurrent(cfg),
          { policy, aliases: new Set(["requester"]) },
        );
      let prepared: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
      let replacementRead: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
      const observed: Array<{ visibility: SessionEntry["visibility"]; member: boolean }> = [];
      const observationErrors: unknown[] = [];
      // This observer precedes the retained reader: installation must belong to commit, not notification order.
      const stop = sessionChanges.subscribe((change) => {
        if (
          prepared &&
          "sessionKey" in change &&
          change.sessionKey === sessionKey &&
          change.storePath === databasePath
        ) {
          try {
            const current = prepared.readCurrent(cfg);
            observed.push({
              visibility: current.target.entry.visibility,
              member: current.membership.has("requester"),
            });
          } catch (error) {
            observationErrors.push(error);
          }
        }
      });
      try {
        const preparationSql = observeHostDataSql(state.env);
        try {
          prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
          for (const call of preparationSql.calls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          preparationSql.restore();
        }
        const read = prepared;
        const assertWithoutSql = (allowed: boolean) => {
          const sql = observeHostDataSql(state.env);
          try {
            expect(authorize(read) === null).toBe(allowed);
            for (const call of sql.calls) {
              expect(call).not.toHaveBeenCalled();
            }
          } finally {
            sql.restore();
          }
        };
        assertWithoutSql(true);
        replaceSessionEntrySync(scope, { ...entry, label: "cosmetic change", updatedAt: 2 });
        assertWithoutSql(true);
        expect(observed.at(-1)).toEqual({ visibility: "read-only", member: true });
        await removeSessionMember(scope, "requester");
        assertWithoutSql(kind === "incognito");
        expect(observed.at(-1)).toEqual({ visibility: "read-only", member: false });
        observed.length = 0;
        const target = read.readCurrent(cfg).target;
        runOpenClawAgentWriteTransaction(
          (database) => {
            writeSessionEntry(database, sessionKey, {
              ...target.entry,
              visibility: "shared",
              updatedAt: 3,
            });
            if (kind === "incognito") {
              expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
            }
            writeSessionEntry(database, sessionKey, {
              ...target.entry,
              visibility: "draft",
              updatedAt: 4,
            });
          },
          { agentId: target.agentId, path: databasePath },
        );
        expect(observed).toEqual([
          { visibility: "draft", member: false },
          { visibility: "draft", member: false },
        ]);
        expect(observationErrors).toEqual([]);
        assertWithoutSql(kind === "incognito");
        if (kind === "incognito") {
          const ordinary = sharingPolicyClient({ user: "requester" });
          expect(
            authorizePreparedSessionMutation(
              { cfg, client: ordinary, sessionKey, agentId: "main" },
              read.readCurrent(cfg),
              { policy, aliases: new Set(["requester"]) },
            )?.message,
          ).toContain("was not found");
          policy.agents = [];
          assertWithoutSql(false);
          expect(fs.existsSync(target.storePath)).toBe(false);
        }
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, sessionKey, {
              ...target.entry,
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
              updatedAt: 5,
            }),
          { agentId: target.agentId, path: databasePath },
        );
        expect(observationErrors).toHaveLength(1);
        expect(observationErrors[0]).toBeInstanceOf(Error);
        expect(observationErrors[0]).toHaveProperty("message", unavailableMessage);
        expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
        replacementRead = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
        expect(replacementRead.readCurrent(cfg).target.entry.sessionId).toBe("replacement-session");
        await closeOpenClawAgentDatabaseByPathAsync(databasePath, target.agentId);
        expect(() => replacementRead!.readCurrent(cfg)).toThrow(unavailableMessage);
        read.release();
        read.release();
      } finally {
        stop();
        replacementRead?.release();
        prepared?.release();
      }
    });
  },
);

it("rejects unavailable durable metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("unavailable.sqlite");
    fs.writeFileSync(storePath, "");
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await expect(
      prepareSessionMutationFacts({ cfg, sessionKey: "agent:main:sharing", agentId: "main" }),
    ).rejects.toThrow(unavailableMessage);
  });
});

it("requires an existing session before preparing sharing facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("negative-sharing.sqlite");
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: {} } },
      session: { store: storePath },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:absent";
    await expect(prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" })).rejects.toThrow(
      unavailableMessage,
    );
    const missingDatabase = await prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    });
    try {
      expect(missingDatabase.readCurrent(cfg).target).toBeNull();
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(missingDatabase.readCurrent(cfg).target).toBeNull();
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:existing", storePath },
        { sessionId: "existing", updatedAt: 1 },
      );
      expect(() => missingDatabase.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      missingDatabase.release();
    }
    await expect(prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" })).rejects.toThrow(
      unavailableMessage,
    );
    const missingEntry = await prepareSessionMutationFacts({
      cfg,
      sessionKey,
      agentId: "main",
      allowMissing: true,
    });
    try {
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(missingEntry.readCurrent(cfg).target).toBeNull();
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "new-restricted-session",
          lifecycleRevision: "new-restricted-generation",
          updatedAt: 1,
          visibility: "draft",
          sandbox: "required",
          createdActor: { type: "human", source: "profile", id: "other" },
        },
      );
      expect(() => missingEntry.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      missingEntry.release();
    }
    const prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
    try {
      const client = sharingPolicyClient({ user: "requester" });
      const policy = { ...cfg.gateway!.roles!.definitions.view!, sandbox: "required" as const };
      const facts = prepared.readCurrent(cfg);
      expect(facts.target.entry.sessionId).toBe("new-restricted-session");
      expect(
        authorizePreparedSessionMutation({ cfg, client, sessionKey, agentId: "main" }, facts, {
          policy,
          aliases: new Set(["requester"]),
        })?.message,
      ).toContain("session is draft");
    } finally {
      prepared.release();
    }
  });
});

it.each(["directory", "custom-family", "same path"] as const)(
  "does not transfer prepared sharing facts through a %s replacement",
  async (layout) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const original = state.statePath("original", "session.sqlite");
      const replacement = state.statePath("replacement", "session.sqlite");
      const alias = state.statePath(layout === "directory" ? "selected" : "custom.sqlite");
      const sessionKey = "agent:main:sharing";
      for (const storePath of [original, replacement]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey, storePath },
          { sessionId: "identical", lifecycleRevision: "same", updatedAt: 1, visibility: "shared" },
        );
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      }
      const link = (storePath: string, directory: string) => {
        if (layout === "directory") {
          fs.symlinkSync(state.statePath(directory), alias, "junction");
        } else {
          fs.symlinkSync(storePath, alias, "file");
        }
      };
      if (layout !== "same path") {
        link(original, "original");
      }
      const cfg = {
        agents: { entries: { main: {} } },
        session: {
          store:
            layout === "same path"
              ? original
              : state.statePath(
                  ...(layout === "directory" ? ["selected", "session.sqlite"] : ["custom.json"]),
                ),
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      try {
        expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("identical");
        if (layout !== "same path") {
          fs.rmSync(alias, { recursive: true });
          link(replacement, "replacement");
        } else {
          fs.renameSync(original, state.statePath("retired.sqlite"));
          fs.renameSync(replacement, original);
          registerOpenClawAgentDatabase({ agentId: "main", path: original, env: state.env });
        }
        expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
      } finally {
        prepared.release();
      }
    });
  },
);

it("invalidates selected facts before observers when another searched store gains a duplicate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:multiple-stores";
    const primaryStore = state.statePath(
      "configured",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const secondaryStore = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const cfg = {
      agents: { entries: { main: {} } },
      session: {
        store: state.statePath("configured", "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath: primaryStore },
      { sessionId: "selected", updatedAt: 1, visibility: "shared" },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other", storePath: secondaryStore },
      { sessionId: "other", updatedAt: 1 },
    );
    const scope = { cfg, sessionKey, agentId: "main" };
    expect(resolveSessionSharingTarget(scope)?.entry.sessionId).toBe("selected");
    let prepared: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
    const observed: unknown[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if (
        prepared &&
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        change.storePath === secondaryStore
      ) {
        try {
          observed.push(prepared.readCurrent(cfg));
        } catch (error) {
          observed.push(error);
        }
      }
    });
    try {
      prepared = await prepareSessionMutationFacts(scope);
      expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("selected");
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath: secondaryStore },
        {
          sessionId: "duplicate",
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "other" },
        },
      );
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeInstanceOf(Error);
      expect(observed[0]).toHaveProperty("message", unavailableMessage);
      expect(() => prepared!.readCurrent(cfg)).toThrow(unavailableMessage);
      expect(() => resolveSessionSharingTarget(scope)).toThrow(
        "duplicate rows resolve to canonical session key",
      );
    } finally {
      stop();
      prepared?.release();
    }
  });
});
