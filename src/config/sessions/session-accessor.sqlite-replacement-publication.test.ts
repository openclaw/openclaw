import { afterEach, expect, it, vi } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

// The canonical executor still owns real SQL, admission, and settlement; only reply delivery changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void | Promise<void>) | undefined,
  releaseFailure: undefined as Error | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    await delivery.afterResult?.();
                  }
                  return result;
                },
              }),
            options,
          ),
        release: async () => {
          await owned.release();
          if (delivery.releaseFailure) {
            throw delivery.releaseFailure;
          }
        },
      };
    },
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.releaseFailure = undefined;
});

it.each([
  "lost result",
  "release failure",
  "newer native write",
  "newer native write after reset",
  "late writer",
] as const)("preserves replacement publication through %s", async (boundary) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:replacement-settlement";
    const reset = boundary === "newer native write after reset";
    const newerNative = boundary === "newer native write" || reset;
    const original = {
      sessionId: "settlement",
      lifecycleRevision: "initial-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
      label: "before",
      category: "before",
    };
    writeSessionEntry(database, sessionKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const projection = createSessionMembershipProjection();
    projection.updateTargets([
      { ...options, storePath: database.path, ...readOpenClawAgentDatabaseIdentity(database) },
    ]);
    const stopFacts = sessionChanges.subscribeFacts(projection.invalidate);
    await projection.prepare();
    expect([...projection.groupTargets().keys()]).toEqual(["before"]);
    let writer = database;
    if (boundary === "late writer") {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    } else {
      readSessionEntryCache(writer, { cache: true });
    }
    const observed: Array<string | undefined> = [];
    const caches: unknown[] = [];
    const mutations: SessionIdentityMutation[] = [];
    const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        observed.push(sharing.readCurrent()?.entry?.visibility);
        caches.push(readCommittedSessionEntryCache(writer.db)?.get(sessionKey)?.label);
      }
    });
    let executions = 0;
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    const failure = new Error(`synthetic ${boundary}`);
    delivery.afterResult = () => {
      executions++;
      whileWaiting = sharing.readCurrent();
      if (boundary === "lost result") {
        throw failure;
      }
      if (newerNative) {
        replaceSessionEntrySync(
          { agentId: "main", storePath: database.path, sessionKey },
          {
            ...readExactSessionEntryRow(database, sessionKey)!.entry,
            updatedAt: 3,
            visibility: "draft",
            label: "newer",
            category: "newer",
          },
        );
      }
    };
    if (boundary === "release failure") {
      delivery.releaseFailure = failure;
    }
    try {
      const operation = applySessionEntryExactReplacements({
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: ([row]) => {
          if (boundary === "late writer") {
            writer = openOpenClawAgentDatabase(options);
            readSessionEntryCache(writer, { cache: true });
          }
          return {
            result: undefined,
            replacements: [
              {
                sessionKey,
                entry: {
                  ...row!.entry,
                  visibility: "read-only",
                  label: "worker",
                  category: "worker",
                  ...(reset ? { lifecycleRevision: "next-lifecycle" } : {}),
                },
              },
            ],
          };
        },
      });
      if (boundary === "lost result" || boundary === "release failure") {
        await expect(operation).rejects.toBe(failure);
      } else {
        await operation;
      }
      expect(executions).toBe(1);
      if (boundary !== "late writer") {
        expect(whileWaiting).toBeUndefined();
      }
      if (reset) {
        expect(sharing.readCurrent()).toBeUndefined();
      } else {
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: newerNative ? "draft" : "read-only" },
          membership: new Set(["member"]),
        });
      }
      expect(mutations).toEqual(
        reset
          ? [
              {
                agentId: "main",
                kind: "reset",
                previous: { sessionId: "settlement", sessionKeys: [sessionKey] },
                current: { sessionId: "settlement", sessionKeys: [sessionKey] },
              },
            ]
          : [],
      );
      expect(readExactSessionEntryRow(writer, sessionKey)?.entry.label).toBe(
        newerNative ? "newer" : "worker",
      );
      await projection.prepare();
      expect([...projection.groupTargets()]).toEqual([
        [newerNative ? "newer" : "worker", [{ sessionKey, agentId: "main" }]],
      ]);
      expect(observed).toEqual([reset ? undefined : newerNative ? "draft" : "read-only"]);
      if (boundary === "late writer") {
        expect(caches).toEqual([undefined]);
      }
    } finally {
      delivery.afterResult = undefined;
      delivery.releaseFailure = undefined;
      stop();
      stopIdentity();
      stopFacts();
      projection.dispose();
      sharing.release();
    }
  });
});

it("keeps uncertain alias membership unavailable after newer native metadata settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:replacement-unknown-membership";
    const entry = {
      sessionId: "unknown-membership",
      lifecycleRevision: "unchanged-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
    };
    writeSessionEntry(database, sessionKey, entry);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(entry),
      membership: new Set(["previous-member"]),
    });
    const publication = retainSessionEntryWorkerPublication({
      agentId: "main",
      storePath: database.path,
      databaseIdentity: identity,
    });
    const invalidations: string[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey && change.factsInvalidated) {
        invalidations.push(change.sessionKey);
      }
    });
    try {
      publication.begin([sessionKey], [sessionKey]);
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey },
        { ...entry, updatedAt: 2, visibility: "draft" },
      );
      expect(sharing.readCurrent()).toBeUndefined();
      expect(invalidations).toEqual([]);
      publication.settle(undefined, true);
      expect(sharing.readCurrent()).toBeUndefined();
      expect(invalidations).toEqual([sessionKey]);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe("draft");
    } finally {
      publication.settle(undefined, false);
      stop();
      sharing.release();
    }
  });
});

it.each([false, true])(
  "invalidates rehomed membership while preserving newer native metadata (%s)",
  async (newerNative) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:replacement-member-target";
      const aliasKey = "agent:main:replacement-member-alias";
      const entry = {
        sessionId: "member-target",
        lifecycleRevision: "unchanged-lifecycle",
        updatedAt: 2,
        visibility: "shared" as const,
      };
      writeSessionEntry(database, sessionKey, entry);
      writeSessionEntry(database, aliasKey, { sessionId: "member-alias", updatedAt: 1 });
      for (const [key, identityId] of [
        [sessionKey, "target-member"],
        [aliasKey, "alias-member"],
      ] as const) {
        addSessionMember(
          { agentId: "main", storePath: database.path, sessionKey: key },
          { identityId, addedBy: "owner", addedAt: 1 },
        );
      }
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey,
        entry: projectSessionSharingEntry(entry),
        membership: new Set(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ),
      });
      expect(sharing.readCurrent()?.membership).toEqual(new Set(["target-member"]));
      delivery.afterResult = () => {
        if (newerNative) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey },
            { ...entry, updatedAt: 3, visibility: "draft" },
          );
          expect(sharing.readCurrent()).toBeUndefined();
        }
      };
      try {
        await applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey, aliasKey],
          update: () => ({
            result: undefined,
            replacements: [{ sessionKey, previousSessionKeys: [aliasKey], entry }],
          }),
        });
        expect(readExactSessionEntryRow(database, aliasKey)).toBeUndefined();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe(
          newerNative ? "draft" : "shared",
        );
        expect(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ).toEqual(["alias-member", "target-member"]);
        expect(sharing.readCurrent()).toBeUndefined();
      } finally {
        delivery.afterResult = undefined;
        sharing.release();
      }
    });
  },
);

it("fences inline maintenance rows and preserves a newer native publication for them", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { resetConfigRuntimeState, setRuntimeConfigSnapshot } = await import("../config.js");
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const activeKey = "agent:main:replacement-maintenance-active";
    const siblingKey = "agent:main:replacement-maintenance-sibling";
    const archivedKey = "agent:main:replacement-maintenance-old";
    writeSessionEntry(database, activeKey, { sessionId: "active", updatedAt: Date.now() });
    writeSessionEntry(database, siblingKey, { sessionId: "sibling", updatedAt: Date.now() });
    const original = { sessionId: "maintenance-old", updatedAt: 1, visibility: "shared" as const };
    writeSessionEntry(database, archivedKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey: archivedKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const config = {
      session: { maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" } },
    };
    setRuntimeConfigSnapshot(config, config);
    const replacementKeys = [activeKey, siblingKey];
    const factKeys = new Set<string>();
    const observerFacts: string[][] = [];
    const stopFacts = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
        factKeys.add(change.sessionKey);
      }
    });
    const stopObserver = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
        observerFacts.push([...factKeys].toSorted());
      }
    });
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    delivery.afterResult = () => {
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.archivedAt).toEqual(
        expect.any(Number),
      );
      whileWaiting = sharing.readCurrent();
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey: archivedKey },
        { ...original, updatedAt: Date.now(), visibility: "draft", label: "newer maintenance row" },
      );
    };
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        activeSessionKey: activeKey,
        sessionKeys: replacementKeys,
        skipMaintenance: false,
        update: (rows) => ({
          result: undefined,
          replacements: rows.map(({ sessionKey, entry }) => ({
            sessionKey,
            entry: { ...entry, label: "updated" },
          })),
        }),
      });
      expect(observerFacts).toEqual([replacementKeys.toSorted(), replacementKeys.toSorted()]);
      expect(whileWaiting).toBeUndefined();
      expect(sharing.readCurrent()).toMatchObject({
        entry: { visibility: "draft" },
        membership: new Set(["member"]),
      });
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.label).toBe(
        "newer maintenance row",
      );
    } finally {
      delivery.afterResult = undefined;
      resetConfigRuntimeState();
      stopObserver();
      stopFacts();
      sharing.release();
    }
  });
});
