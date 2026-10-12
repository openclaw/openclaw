import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { publishSessionEntryCacheInvalidation } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  assertExistingDatabaseIdentity,
  readDatabaseIdentityBirthtime,
} from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
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

function expectWithoutHostSql(action: () => void) {
  const sql = observeHostDataSql();
  try {
    action();
    for (const call of sql.calls) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    sql.restore();
  }
}

it("enforces host birthtime identity across same-inode replacement and registration", async () => {
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
      const assertOriginal = () =>
        assertExistingDatabaseIdentity(
          storePath,
          `file:${original.dev}:${original.ino}`,
          readDatabaseIdentityBirthtime(original),
        );
      // Linux cannot distinguish native birthtime from Node's ctime fallback.
      if (process.platform === "linux") {
        expect(assertOriginal).not.toThrow();
      } else {
        expect(assertOriginal).toThrow(
          "SQLite database file identity changed before existing-only open",
        );
      }
      for (const registered of [false, true]) {
        if (registered) {
          registerOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
        }
        if (process.platform === "linux") {
          expect(authorize()).toBeNull();
        } else {
          expect(authorize).toThrow(unavailableMessage);
        }
      }
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
      prepared.release();
    }
  });
});

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
    const readEntries = entryReads.readSessionEntriesFromStoreInWorker;
    const observed: Array<Awaited<ReturnType<typeof readEntries>>["databaseIdentity"]> = [];
    const reader = vi
      .spyOn(entryReads, "readSessionEntriesFromStoreInWorker")
      .mockImplementation(async (...args) => {
        const [input] = args;
        const loaded = await readEntries(...args);
        if (input.projection !== "sharing") {
          return loaded;
        }
        observed.push(loaded.databaseIdentity);
        return loaded.databaseIdentity
          ? {
              ...loaded,
              databaseIdentity: {
                ...loaded.databaseIdentity,
                birthtime: (BigInt(readDatabaseIdentityBirthtime(file)) + 1n).toString(),
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
          birthtime: readDatabaseIdentityBirthtime(file),
          incarnation: expect.any(String),
        }),
      ]);
    } finally {
      prepared?.release();
      reader.mockRestore();
    }
  });
});

it.each(["remove", "reassignment", "ABA", "unknown", "rollback"] as const)(
  "retains only unchanged sharing sources after a %s registry publication",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const registration = { agentId: "main", path: storePath, env: state.env };
      openOpenClawAgentDatabase(registration);
      const cfg = { agents: { entries: { ops: {} } }, session: { store: storePath } };
      const agentId = "ops";
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
        if (change === "rollback") {
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

it.each(["main", "research"])(
  "retains %s mutation facts across agent roster publications",
  async (agentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
      const cfg = { agents: { entries: { [agentId]: {} } } };
      const target = { agentId, sessionKey: `agent:${agentId}:roster-sharing` };
      replaceSessionEntrySync(
        { ...target, storePath },
        { sessionId: "unaffected", lifecycleRevision: "first", updatedAt: 1 },
      );
      setRuntimeConfigSnapshot(cfg);
      const prepared = await prepareSessionMutationFacts({ cfg, ...target });
      try {
        const added = { agents: { entries: { [agentId]: {}, other: {} } } };
        for (const current of [added, cfg]) {
          setRuntimeConfigSnapshot(current);
          expect(prepared.readCurrent(current).target.entry.sessionId).toBe("unaffected");
        }
        const removed = { ...cfg, agents: { entries: { other: {} } } };
        setRuntimeConfigSnapshot(removed);
        expect(() => prepared.readCurrent(removed)).toThrow(unavailableMessage);
      } finally {
        prepared.release();
      }
    });
  },
);

it("keeps durable sharing facts current before observers without SQL in retained assertions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:sharing";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { agentId: "main", sessionKey };
    const entry: SessionEntry = {
      sessionId: "sharing-session",
      lifecycleRevision: "sharing-generation",
      updatedAt: 1,
      visibility: "read-only",
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: "creator" },
    };
    replaceSessionEntrySync(scope, entry);
    await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
    const client = sharingPolicyClient({
      user: "requester",
      scopes: ["operator.read", "operator.write"],
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
      const preparationSql = observeHostDataSql();
      try {
        prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
        for (const call of preparationSql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        preparationSql.restore();
      }
      const read = prepared;
      const assertWithoutSql = (allowed: boolean) =>
        expectWithoutHostSql(() => expect(authorize(read) === null).toBe(allowed));
      assertWithoutSql(true);
      sessionChanges.emit({ all: true, scope: "subagent-runs" });
      assertWithoutSql(true);
      replaceSessionEntrySync(scope, {
        ...entry,
        archivedAt: 2,
        label: "cosmetic change",
        updatedAt: 2,
      });
      expect(read.readCurrent(cfg).target.entry.archivedAt).toBe(2);
      assertWithoutSql(true);
      expect(observed.at(-1)).toEqual({ visibility: "read-only", member: true });
      await removeSessionMember(scope, "requester");
      assertWithoutSql(false);
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
      assertWithoutSql(false);
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
});

it.each([
  "worker-metadata",
  "visibility",
  "membership",
  "lifecycle",
  "replacement",
  "retirement",
  "unknown",
  "rollback",
] as const)("reconciles a stale sharing worker return across %s publication", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:acquiring-sharing";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const scope = { agentId: "main", sessionKey, storePath };
    const entry: SessionEntry = {
      sessionId: "acquiring-session",
      lifecycleRevision: "original",
      updatedAt: 1,
      visibility: "read-only",
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: "creator" },
    };
    replaceSessionEntrySync(scope, entry);
    await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
    const originalRead = entryReads.readSessionEntriesFromStoreInWorker;
    let publications = 0;
    vi.spyOn(entryReads, "readSessionEntriesFromStoreInWorker").mockImplementation(
      async (...args) => {
        const snapshot = await originalRead(...args);
        if (!publications && snapshot.entries.some((row) => row.sessionKey === sessionKey)) {
          publications++;
          if (change === "unknown") {
            runOpenClawAgentWriteTransaction(
              (database) => {
                publishSessionEntryCacheInvalidation(database, { sessionKey });
              },
              { agentId: "main", path: storePath },
            );
          } else if (change === "rollback") {
            const rollback = new Error("Synthetic sharing rollback");
            expect(() =>
              runOpenClawAgentWriteTransaction(
                (database) => {
                  writeSessionEntry(database, sessionKey, {
                    ...entry,
                    visibility: "draft",
                    updatedAt: 2,
                  });
                  throw rollback;
                },
                { agentId: "main", path: storePath },
              ),
            ).toThrow(rollback);
          } else if (change === "membership") {
            await removeSessionMember(scope, "requester");
          } else if (change === "retirement") {
            await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
          } else if (change === "lifecycle" || change === "replacement") {
            // Exercise the entry publisher itself, without a separate lifecycle event.
            runOpenClawAgentWriteTransaction(
              (database) => {
                writeSessionEntry(database, sessionKey, {
                  ...entry,
                  ...(change === "lifecycle"
                    ? { lifecycleRevision: "replacement" }
                    : { sessionId: "replacement-session" }),
                  updatedAt: 2,
                });
                writeSessionEntry(database, sessionKey, entry);
              },
              { agentId: "main", path: storePath },
            );
          } else if (change === "worker-metadata") {
            await replaceSessionEntry(scope, { ...entry, updatedAt: 2, label: "worker metadata" });
          } else {
            replaceSessionEntrySync(scope, {
              ...entry,
              updatedAt: 2,
              visibility: "draft",
            });
          }
        }
        return snapshot;
      },
    );
    const pending = prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
    if (
      change === "lifecycle" ||
      change === "replacement" ||
      change === "retirement" ||
      change === "unknown"
    ) {
      await expect(pending).rejects.toThrow(unavailableMessage);
    } else {
      const read = await pending;
      try {
        expectWithoutHostSql(() => {
          const facts = read.readCurrent(cfg);
          expect(facts.target.entry.updatedAt).toBe(
            change === "membership" || change === "rollback" ? 1 : 2,
          );
          expect(facts.membership.has("requester")).toBe(change !== "membership");
          const policy = { ...cfg.gateway!.roles!.definitions.view!, sandbox: "required" as const };
          expect(
            authorizePreparedSessionMutation(
              {
                cfg,
                client: sharingPolicyClient({ user: "requester" }),
                sessionKey,
                agentId: "main",
              },
              facts,
              { policy, aliases: new Set(["requester"]) },
            ) === null,
          ).toBe(change === "worker-metadata" || change === "rollback");
        });
      } finally {
        read.release();
      }
      expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
    }
    expect(publications).toBe(1);
  });
});

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

it.each(["directory", "same path"] as const)(
  "does not transfer prepared sharing facts through a %s replacement",
  async (layout) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const original = state.statePath("original", "session.sqlite");
      const replacement = state.statePath("replacement", "session.sqlite");
      const alias = state.statePath("selected");
      const sessionKey = "agent:main:sharing";
      for (const storePath of [original, replacement]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey, storePath },
          { sessionId: "identical", lifecycleRevision: "same", updatedAt: 1, visibility: "shared" },
        );
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      }
      const link = (directory: string) =>
        fs.symlinkSync(state.statePath(directory), alias, "junction");
      if (layout !== "same path") {
        link("original");
      }
      const cfg = {
        agents: { entries: { main: {} } },
        session: {
          store: layout === "same path" ? original : state.statePath("selected", "session.sqlite"),
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
      try {
        expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("identical");
        if (layout !== "same path") {
          fs.rmSync(alias, { recursive: true });
          link("replacement");
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
