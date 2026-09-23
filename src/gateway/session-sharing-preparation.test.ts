import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as registryListing from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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
        const missingKey = `${sessionKey}-missing`;
        const negative = await prepareSessionMutationFacts({
          cfg,
          sessionKey: missingKey,
          agentId: "main",
          allowMissing: true,
        });
        try {
          expect(negative.readCurrent(cfg).target).toBeNull();
          replaceSessionEntrySync(scope, { ...entry, label: "cosmetic change", updatedAt: 2 });
          expect(negative.readCurrent(cfg).target).toBeNull();
          replaceSessionEntrySync(
            { ...scope, sessionKey: missingKey },
            {
              ...entry,
              sessionId: "appeared-session",
              lifecycleRevision: "appeared-generation",
              updatedAt: 2,
            },
          );
          expect(() => negative.readCurrent(cfg)).toThrow(unavailableMessage);
        } finally {
          negative.release();
        }
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

it.each([
  "registry-only",
  "identity-before-catch",
  "identity-during-wait",
  "negative-during-wait",
  "memo-switch",
  "registration-memo-switch",
  "second-registration-during-wait",
  "second-registration-before-registry-read",
  "second-registration",
] as const)(
  "keeps initial registration recovery bound to its original identity (%s)",
  async (overlap) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("registry-recovery.sqlite");
      const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:registry-recovery", storePath };
      const initial = {
        sessionId: "original-session",
        lifecycleRevision: "original-generation",
        updatedAt: 1,
      };
      if (overlap === "negative-during-wait") {
        replaceSessionEntrySync(
          { ...scope, sessionKey: "agent:main:other" },
          { sessionId: "other-session", updatedAt: 1 },
        );
      } else {
        replaceSessionEntrySync(scope, initial);
      }
      const shared = openOpenClawStateDatabase({ env: state.env });
      const admission = captureOpenClawStateDatabaseReadAdmission(shared.path);
      const captureRegistration = () =>
        registryListing.captureOpenClawAgentDatabaseRegistration({
          agentId: scope.agentId,
          agentPath: storePath,
          admission,
        });
      const enteredRead = createDeferredCore();
      const releaseRead = createDeferredCore();
      const enteredWait = createDeferredCore();
      const read = sessionEntryReads.readSessionEntriesFromStoreInWorker;
      const retain = entryCache.retainPreparedSessionSharingFacts;
      const prepareRegistry = registryListing.prepareOpenClawAgentDatabaseRegistrySnapshotRead;
      let registration: ReturnType<typeof captureRegistration> | undefined;
      let registrationFinished = false;
      let reads = 0;
      let interruptedBeforeRegistryRead = false;
      const registrySpy = vi
        .spyOn(registryListing, "prepareOpenClawAgentDatabaseRegistrySnapshotRead")
        .mockImplementation((options) => {
          const prepared = prepareRegistry(options);
          let snapshotReads = 0;
          return {
            read: async () => {
              snapshotReads += 1;
              if (overlap === "second-registration-before-registry-read" && snapshotReads === 2) {
                expect(registrationFinished).toBe(true);
                const second = captureRegistration();
                second.begin();
                second.finish();
                interruptedBeforeRegistryRead = true;
              }
              return await prepared.read();
            },
          };
        });
      const readSpy = vi
        .spyOn(sessionEntryReads, "readSessionEntriesFromStoreInWorker")
        .mockImplementation(async (params) => {
          const result = await read(params);
          reads += 1;
          if (reads === 1) {
            enteredRead.resolve();
            await releaseRead.promise;
          } else if (overlap === "second-registration" && reads === 2) {
            const second = captureRegistration();
            second.begin();
            second.finish();
          }
          return result;
        });
      const retainSpy = vi
        .spyOn(entryCache, "retainPreparedSessionSharingFacts")
        .mockImplementation((params) => {
          const retained = retain(params);
          const readCurrent = retained.readCurrent;
          vi.spyOn(retained, "readCurrent").mockImplementation(() => {
            const current = readCurrent();
            if (registration && !registrationFinished) {
              if (overlap === "negative-during-wait" && params.sessionKey === scope.sessionKey) {
                expect(current).toBeDefined();
                expect(current?.entry).toBeUndefined();
              }
              // The synchronous recovery guard is immediately before the receipt await.
              // This continuation runs only after the helper yields to that settlement.
              enteredWait.resolve();
            }
            return current;
          });
          return retained;
        });
      let settled = false;
      const outcome = prepareSessionMutationFacts({ cfg, ...scope, allowMissing: true }).then(
        (value) => {
          settled = true;
          return { kind: "ready" as const, prepared: value };
        },
        (error: unknown) => {
          settled = true;
          return { kind: "error" as const, error };
        },
      );
      const replaceIdentity = () =>
        replaceSessionEntrySync(scope, {
          ...initial,
          sessionId: "replacement-session",
          lifecycleRevision: "replacement-generation",
        });
      try {
        await Promise.race([
          enteredRead.promise,
          outcome.then((result) => {
            throw new Error(`Preparation finished before the read boundary: ${result.kind}`);
          }),
        ]);
        if (overlap === "memo-switch") {
          registryListing.readOpenClawAgentDatabaseRegistryToken({
            path: state.statePath("unrelated-registry.sqlite"),
          });
        } else {
          registration = captureRegistration();
          registration.begin();
          if (overlap === "registration-memo-switch") {
            registryListing.readOpenClawAgentDatabaseRegistryToken({
              path: state.statePath("unrelated-registry.sqlite"),
            });
          }
        }
        if (overlap === "identity-before-catch") {
          replaceIdentity();
        }
        releaseRead.resolve();
        if (
          overlap === "registry-only" ||
          overlap === "identity-during-wait" ||
          overlap === "negative-during-wait" ||
          overlap === "second-registration-during-wait" ||
          overlap === "second-registration-before-registry-read" ||
          overlap === "second-registration"
        ) {
          await Promise.race([
            enteredWait.promise,
            outcome.then((result) => {
              throw new Error(
                `Preparation finished before registration settlement wait: ${result.kind}`,
              );
            }),
          ]);
          expect(settled).toBe(false);
          if (overlap === "identity-during-wait") {
            replaceIdentity();
          } else if (overlap === "negative-during-wait") {
            replaceSessionEntrySync(scope, initial);
          } else if (overlap === "second-registration-during-wait") {
            const second = captureRegistration();
            second.begin();
            second.finish();
          }
        }
        registration?.finish();
        registrationFinished = true;
        const result = await outcome;
        if (overlap === "registry-only") {
          if (result.kind !== "ready") {
            throw result.error;
          }
          expect(result.prepared.readCurrent(cfg).target?.entry.sessionId).toBe(initial.sessionId);
          const readsBeforeRevocation = readSpy.mock.calls.length;
          const later = captureRegistration();
          later.begin();
          try {
            expect(() => result.prepared.readCurrent(cfg)).toThrow(unavailableMessage);
            expect(readSpy).toHaveBeenCalledTimes(readsBeforeRevocation);
          } finally {
            later.finish();
          }
        } else {
          expect(result).toMatchObject({ kind: "error", error: { message: unavailableMessage } });
          if (overlap === "memo-switch" || overlap === "registration-memo-switch") {
            expect(result).toMatchObject({
              error: { cause: expect.any(registryListing.AgentDatabaseRegistryChangedError) },
            });
            if (result.kind === "error") {
              expect(result.error).toHaveProperty("cause.registrationSettlement", undefined);
            }
            expect(reads).toBe(1);
          } else if (overlap === "second-registration") {
            expect(reads).toBe(2);
          } else if (overlap === "second-registration-during-wait") {
            expect(reads).toBe(1);
          } else if (overlap === "second-registration-before-registry-read") {
            expect(interruptedBeforeRegistryRead).toBe(true);
          }
        }
      } finally {
        releaseRead.resolve();
        registration?.finish();
        const result = await outcome;
        if (result.kind === "ready") {
          result.prepared.release();
        }
        readSpy.mockRestore();
        retainSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });
  },
);

it.each(["negative-sharing.sqlite", "sessions.json"])(
  "requires an existing session before preparing sharing facts through %s",
  async (locator) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath(locator);
      const cfg = {
        ...rolePolicyConfig(),
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:absent";
      await expect(
        prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" }),
      ).rejects.toThrow(unavailableMessage);
      const absent = await prepareSessionMutationFacts({
        cfg,
        sessionKey,
        agentId: "main",
        allowMissing: true,
      });
      try {
        const sql = observeHostDataSql(state.env);
        try {
          expect(absent.readCurrent(cfg).target).toBeNull();
          sessionChanges.emit({ all: true, scope: "catalog" });
          expect(absent.readCurrent(cfg).target).toBeNull();
          for (const call of sql.calls) {
            expect(call).not.toHaveBeenCalled();
          }
        } finally {
          sql.restore();
        }
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:existing", storePath },
          { sessionId: "existing", updatedAt: 1 },
        );
        expect(() => absent.readCurrent(cfg)).toThrow(unavailableMessage);
      } finally {
        absent.release();
      }
      await expect(
        prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" }),
      ).rejects.toThrow(unavailableMessage);
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
  },
);

it("invalidates a raw global read when its fixed-store owner changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: {
        entries: { main: {}, ops: {} },
        defaults: { sessionStore: { agentId: "main" } },
      },
      session: { store: state.statePath("fixed-owner.sqlite") },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "global", storePath: cfg.session.store },
      { sessionId: "original-global", updatedAt: 1 },
    );
    const prepared = await prepareSessionMutationFacts({
      cfg,
      sessionKey: "global",
      agentId: "main",
    });
    try {
      const sql = observeHostDataSql(state.env);
      try {
        expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("original-global");
        expect(() =>
          prepared.readCurrent({
            ...cfg,
            agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "ops" } } },
          }),
        ).toThrow(unavailableMessage);
        for (const call of sql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        sql.restore();
      }
    } finally {
      prepared.release();
    }
  });
});

it("does not transfer prepared sharing facts to a replacement store behind the same alias", async () => {
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
    fs.symlinkSync(state.statePath("original"), alias, "junction");
    const cfg = {
      agents: { entries: { main: {} } },
      session: { store: state.statePath("selected", "session.sqlite") },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const prepared = await prepareSessionMutationFacts({ cfg, sessionKey, agentId: "main" });
    try {
      expect(prepared.readCurrent(cfg).target.entry.sessionId).toBe("identical");
      fs.rmSync(alias, { recursive: true });
      fs.symlinkSync(state.statePath("replacement"), alias, "junction");
      expect(() => prepared.readCurrent(cfg)).toThrow(unavailableMessage);
    } finally {
      prepared.release();
    }
  });
});

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
