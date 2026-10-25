import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it as baseIt, vi } from "vitest";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDatabaseIdentityBirthtime } from "../infra/sqlite-worker-identity.js";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const unavailableMessage =
  "Session access facts are unavailable; retry after session storage is ready.";

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
});

function releasing<T extends { release(): void }>(facts: T) {
  return Object.assign(facts, { [Symbol.dispose]: () => facts.release() });
}

function sharingHarness(
  cfg: OpenClawConfig,
  sessionKey: string,
  storePath?: string,
  agentId = "main",
) {
  const scope = { agentId, sessionKey, storePath };
  const request = { cfg, sessionKey, agentId };
  const transaction = (run: Parameters<typeof runOpenClawAgentWriteTransaction>[0]) =>
    runOpenClawAgentWriteTransaction(run, { agentId, path: storePath });
  return {
    scope,
    prepare: () => prepareSessionMutationFacts(request),
    prepareMissing: () => prepareSessionMutationFacts({ ...request, allowMissing: true }),
    write: (entry: SessionEntry) => replaceSessionEntrySync(scope, entry),
    transaction,
    commit: (...entries: SessionEntry[]) =>
      transaction((database) => {
        for (const entry of entries) {
          writeSessionEntry(database, sessionKey, entry);
        }
      }),
    authorize: (facts: Parameters<typeof authorizePreparedSessionMutation>[1]) =>
      authorizePreparedSessionMutation(
        { ...request, client: sharingPolicyClient({ user: "requester" }) },
        facts,
        {
          policy: { ...cfg.gateway!.roles!.definitions.view!, sandbox: "required" },
          aliases: new Set(["requester"]),
        },
      ),
  };
}

function restrictedEntry(sessionId: string, lifecycleRevision: string): SessionEntry {
  return {
    sessionId,
    lifecycleRevision,
    updatedAt: 1,
    visibility: "read-only",
    sandbox: "required",
    createdActor: { type: "human", source: "profile", id: "creator" },
  };
}

function expectWithoutHostSql(action: () => void) {
  const sql = observeHostDataSql();
  const stat = vi.spyOn(fs, "statSync");
  const fstat = vi.spyOn(fs, "fstatSync");
  syncBuiltinESMExports();
  try {
    action();
    for (const call of [...sql.calls, stat, fstat]) {
      expect(call).not.toHaveBeenCalled();
    }
  } finally {
    stat.mockRestore();
    fstat.mockRestore();
    syncBuiltinESMExports();
    sql.restore();
  }
}

it.for(["runtime", "automation"])(
  "retains sharing facts across metadata but invalidates broad %s changes",
  async (scope, { state }) => {
    const storePath = state.statePath("metadata-sharing.sqlite");
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    const sessionKey = "agent:main:metadata-sharing";
    const harness = sharingHarness(cfg, sessionKey, storePath);
    harness.write(restrictedEntry("metadata-sharing", "first"));
    using prepared = releasing(await harness.prepare());
    sessionChanges.emit({ all: true, scope: "profiles" });
    expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("metadata-sharing");
    sessionChanges.emit({ all: true, scope });
    expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
  },
);

it("refuses a worker sharing result whose captured birthtime differs from its retained source", async ({
  state,
}) => {
  const storePath = state.statePath("sharing-worker-birthtime.sqlite");
  const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
  const sessionKey = "agent:main:worker-birthtime";
  replaceSessionEntrySync(
    { agentId: "main", storePath, sessionKey },
    { sessionId: "original", updatedAt: 1 },
  );
  const file = fs.statSync(storePath, { bigint: true });
  const readEntries = entryReads.readSessionEntriesFromStoreInWorker;
  let forged = false;
  vi.spyOn(entryReads, "readSessionEntriesFromStoreInWorker").mockImplementation(
    async (...args) => {
      const [input] = args;
      const loaded = await readEntries(...args);
      if (input.projection !== "full" || !input.includeAuthorization) {
        return loaded;
      }
      if (!loaded.databaseIdentity) {
        return loaded;
      }
      forged = true;
      return {
        ...loaded,
        databaseIdentity: {
          ...loaded.databaseIdentity,
          birthtime: (BigInt(readDatabaseIdentityBirthtime(file)) + 1n).toString(),
        },
      };
    },
  );
  await expect(
    prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" }).then((read) => {
      read.release();
      return read;
    }),
  ).rejects.toThrow(unavailableMessage);
  expect(forged).toBe(true);
});

it.for(["unknown", "rollback"] as const)(
  "applies %s topology publications to retained sharing facts",
  async (change, { state }) => {
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
    using prepared = releasing(await prepareSessionMutationFacts({ cfg, ...target }));
    if (change === "unknown") {
      sessionChanges.emit({ all: true, scope: "stores" });
    } else {
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            unregisterOpenClawAgentDatabase(registration);
            throw new Error("Synthetic registry rollback");
          },
          { env: state.env },
        ),
      ).toThrow("Synthetic registry rollback");
    }
    if (change === "rollback") {
      expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("registry-sharing");
    } else {
      expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
    }
  },
);

it("does not discover registry-only retired stores outside captured roots", async ({ state }) => {
  const storePath = state.statePath("external-retired.sqlite");
  const registration = { agentId: "retired", path: storePath, env: state.env };
  openOpenClawAgentDatabase(registration);
  const target = { agentId: "retired", sessionKey: "agent:retired:external" };
  replaceSessionEntrySync(
    { ...target, storePath },
    { sessionId: "external-retired", lifecycleRevision: "first", updatedAt: 1 },
  );
  const cfg = { agents: { entries: { main: {} } } };
  using prepared = releasing(
    await prepareSessionMutationFacts({ cfg, ...target, allowMissing: true }),
  );
  expect(prepared.readCurrent(cfg).target).toBeNull();
  unregisterOpenClawAgentDatabase(registration);
  expect(prepared.readCurrent(cfg).target).toBeNull();
});

it.for(["main", "research"])(
  "retains %s mutation facts across agent roster publications",
  async (agentId, { state }) => {
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
    const cfg = { agents: { entries: { [agentId]: {} } } };
    const target = { agentId, sessionKey: `agent:${agentId}:roster-sharing` };
    replaceSessionEntrySync(
      { ...target, storePath },
      { sessionId: "unaffected", lifecycleRevision: "first", updatedAt: 1 },
    );
    setRuntimeConfigSnapshot(cfg);
    using prepared = releasing(await prepareSessionMutationFacts({ cfg, ...target }));
    const added = { agents: { entries: { [agentId]: {}, other: {} } } };
    for (const current of [added, cfg]) {
      setRuntimeConfigSnapshot(current);
      expect(prepared.readCurrent(current).target.entry.sessionId).toBe("unaffected");
    }
    const removed = { ...cfg, agents: { entries: { other: {} } } };
    setRuntimeConfigSnapshot(removed);
    expect(() => prepared.readCurrent(removed)).toThrow(unavailableMessage);
  },
);

it("publishes durable sharing facts before observers", async ({ state }) => {
  const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const sessionKey = "agent:main:sharing";
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const harness = sharingHarness(cfg, sessionKey);
  const { scope } = harness;
  const entry = restrictedEntry("sharing-session", "sharing-generation");
  harness.write(entry);
  await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
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
    prepared = await harness.prepare();
    const read = prepared;
    harness.write({
      ...entry,
      archivedAt: 2,
      label: "cosmetic change",
      updatedAt: 2,
    });
    expect(read.readCurrent(cfg).target.entry.archivedAt).toBe(2);
    expect(observed.at(-1)).toEqual({ visibility: "read-only", member: true });
    await removeSessionMember(scope, "requester");
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
        expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
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
    harness.commit({
      ...target.entry,
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-generation",
      updatedAt: 5,
    });
    expect(observationErrors).toHaveLength(1);
    expect(observationErrors[0]).toBeInstanceOf(Error);
    expect(observationErrors[0]).toHaveProperty("message", unavailableMessage);
    expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
    replacementRead = await harness.prepare();
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

it.for([
  "worker-metadata",
  "visibility",
  "membership",
  "lifecycle",
  "replacement",
  "retirement",
  "unknown",
  "rollback",
] as const)(
  "reconciles a stale sharing worker return across %s publication",
  async (change, { state }) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:acquiring-sharing";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const harness = sharingHarness(cfg, sessionKey, storePath);
    const { scope } = harness;
    const entry = restrictedEntry("acquiring-session", "original");
    harness.write(entry);
    await addSessionMember(scope, { identityId: "requester", addedBy: "creator" });
    const originalRead = entryReads.readSessionEntriesFromStoreInWorker;
    let publications = 0;
    vi.spyOn(entryReads, "readSessionEntriesFromStoreInWorker").mockImplementation(
      async (...args) => {
        const snapshot = await originalRead(...args);
        if (!publications && snapshot.entries.some((row) => row.sessionKey === sessionKey)) {
          publications++;
          if (change === "unknown") {
            harness.transaction((database) => {
              publishSessionEntryCacheInvalidation(database, { sessionKey });
            });
          } else if (change === "rollback") {
            const rollback = new Error("Synthetic sharing rollback");
            expect(() =>
              harness.transaction((database) => {
                writeSessionEntry(database, sessionKey, {
                  ...entry,
                  visibility: "draft",
                  updatedAt: 2,
                });
                throw rollback;
              }),
            ).toThrow(rollback);
          } else if (change === "membership") {
            await removeSessionMember(scope, "requester");
          } else if (change === "retirement") {
            await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
          } else if (change === "lifecycle" || change === "replacement") {
            // Exercise the entry publisher itself, without a separate lifecycle event.
            harness.commit(
              {
                ...entry,
                ...(change === "lifecycle"
                  ? { lifecycleRevision: "replacement" }
                  : { sessionId: "replacement-session" }),
                updatedAt: 2,
              },
              entry,
            );
          } else if (change === "worker-metadata") {
            await replaceSessionEntry(scope, { ...entry, updatedAt: 2, label: "worker metadata" });
          } else {
            harness.write({
              ...entry,
              updatedAt: 2,
              visibility: "draft",
            });
          }
        }
        return snapshot;
      },
    );
    const pending = harness.prepare();
    if (
      change === "lifecycle" ||
      change === "replacement" ||
      change === "retirement" ||
      change === "unknown"
    ) {
      await expect(pending).rejects.toThrow(unavailableMessage);
    } else {
      using read = releasing(await pending);
      expectWithoutHostSql(() => {
        const facts = read.readCurrent(cfg);
        expect(facts.target.entry.updatedAt).toBe(
          change === "membership" || change === "rollback" ? 1 : 2,
        );
        expect(facts.membership.has("requester")).toBe(change !== "membership");
        expect(harness.authorize(facts) === null).toBe(
          change === "worker-metadata" || change === "rollback",
        );
      });
      read.release();
      expect(() => read.readCurrent(cfg)).toThrow(unavailableMessage);
    }
    expect(publications).toBe(1);
  },
);

it("rejects unavailable durable metadata", async ({ state }) => {
  const storePath = state.statePath("unavailable.sqlite");
  fs.writeFileSync(storePath, "");
  const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  await expect(
    prepareSessionMutationFacts({ cfg, sessionKey: "agent:main:sharing", agentId: "main" }),
  ).rejects.toThrow(unavailableMessage);
});

it("requires an existing session before preparing sharing facts", async ({ state }) => {
  const storePath = state.statePath("negative-sharing.sqlite");
  const cfg = {
    ...rolePolicyConfig(),
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const sessionKey = "agent:main:absent";
  const harness = sharingHarness(cfg, sessionKey, storePath);
  await expect(harness.prepare()).rejects.toThrow(unavailableMessage);
  {
    using missingDatabase = releasing(await harness.prepareMissing());
    expect(missingDatabase.readCurrent(cfg).target).toBeNull();
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect(missingDatabase.readCurrent(cfg).target).toBeNull();
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:existing", storePath },
      { sessionId: "existing", updatedAt: 1 },
    );
  }
  await expect(harness.prepare()).rejects.toThrow(unavailableMessage);
  {
    using missingEntry = releasing(await harness.prepareMissing());
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect(missingEntry.readCurrent(cfg).target).toBeNull();
    harness.write({
      sessionId: "new-restricted-session",
      lifecycleRevision: "new-restricted-generation",
      updatedAt: 1,
      visibility: "draft",
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: "other" },
    });
    expect(() => missingEntry.readCurrent(cfg)).toThrow(unavailableMessage);
  }
  using prepared = releasing(await harness.prepare());
  const facts = prepared.readCurrent(cfg);
  expect(facts.target.entry.sessionId).toBe("new-restricted-session");
  expect(harness.authorize(facts)?.message).toContain("session is draft");
});

// Alias retargets apply to the next preparation; captured requests retain their physical store.
it("does not transfer prepared sharing facts through a same-path replacement", async ({
  state,
}) => {
  const original = state.statePath("original", "session.sqlite");
  const replacement = state.statePath("replacement", "session.sqlite");
  const sessionKey = "agent:main:sharing";
  for (const storePath of [original, replacement]) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "identical", lifecycleRevision: "same", updatedAt: 1, visibility: "shared" },
    );
    await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
  }
  const cfg = { agents: { entries: { main: {} } }, session: { store: original } };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  using prepared = releasing(
    await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" }),
  );
  expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("identical");
  fs.renameSync(original, state.statePath("retired.sqlite"));
  fs.renameSync(replacement, original);
  registerOpenClawAgentDatabase({ agentId: "main", path: original, env: state.env });
  expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
});
