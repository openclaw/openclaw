import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "./session-accessor.reset.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SqliteSessionMutationConflictError,
} from "./session-mutation-conflict-error.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-maintenance-kick.js")>()),
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-history-eviction.js")>()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

const delivery = vi.hoisted(() => ({
  currentCommand: "",
  beforeCommand: undefined as ((type: string) => Promise<void>) | undefined,
  afterCommit: undefined as ((type: string) => void) | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  delivery.currentCommand = command.type;
                  try {
                    if (delivery.beforeCommand) {
                      await delivery.beforeCommand(command.type);
                    }
                    const result = await worker.execute(command, commandOptions);
                    delivery.afterCommit?.(command.type);
                    return result;
                  } finally {
                    delivery.currentCommand = "";
                  }
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.beforeCommand = undefined;
  delivery.afterCommit = undefined;
  delivery.currentCommand = "";
  vi.restoreAllMocks();
});

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:lifecycle-worker",
  };
  const initial = {
    sessionId: "lifecycle-original",
    updatedAt: Date.now(),
    createdAt: 123,
    createdVia: "operator" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
    skillsSnapshot: { prompt: "original saved prompt", skills: [] },
    sessionDiffBaseline: {
      version: 1 as const,
      sessionId: "lifecycle-original",
      root: "/synthetic",
      files: [],
    },
  };
  replaceSessionEntrySync(scope, initial);
  return {
    scope,
    initial,
    read: (sessionKey = scope.sessionKey) => readExactSessionEntryRow(database, sessionKey)?.entry,
  };
}

function maintenanceFixture() {
  const f = fixture();
  const siblingKey = "agent:main:lifecycle-old";
  const siblingId = "old-sibling";
  const createdKey = "agent:main:lifecycle-new";
  const now = Date.now();
  replaceSessionEntrySync(
    { ...f.scope, sessionKey: siblingKey },
    { sessionId: siblingId, updatedAt: now - 86_400_000, createdAt: 17 },
  );
  return {
    ...f,
    siblingKey,
    siblingId,
    createdKey,
    upserts: [
      {
        sessionKey: f.scope.sessionKey,
        entry: {
          sessionId: f.initial.sessionId,
          updatedAt: now,
          skillsSnapshot: { prompt: "replacement saved prompt", skills: [] },
        },
      },
      { sessionKey: createdKey, entry: { sessionId: "new-session", updatedAt: now + 1 } },
    ] satisfies [SessionEntryLifecycleUpsert, SessionEntryLifecycleUpsert],
    maintenanceOverride: {
      mode: "enforce" as const,
      maxEntries: 2,
      pruneAfterMs: 30 * 86_400_000,
      preserveRecentMs: null,
    },
  };
}

async function runMaintenanceDrift(
  f: ReturnType<typeof maintenanceFixture>,
  drift: { preserve: () => string[]; change: () => void; removalOnly?: boolean; commits?: boolean },
) {
  const committed = vi.fn();
  const changed = vi.fn(drift.change);
  const stopPreserving = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: drift.preserve,
    dispose() {},
  }));
  if (drift.removalOnly) {
    const reclaim = reclamation.runSqliteSessionReclamation;
    vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation((params) => {
      if (params.plan.kind === "lifecycle-projection-commit") {
        changed();
      }
      return reclaim(params);
    });
  } else {
    probe.admission(admission, (request, grant, callback) => {
      if (delivery.currentCommand === "session.lifecycle.project" && request.stage === "commit") {
        changed();
      }
      callback(request, grant);
    });
  }
  try {
    const operation = applySessionEntryLifecycleMutation({
      ...f.scope,
      ...(drift.removalOnly
        ? { removals: [{ sessionKey: f.scope.sessionKey, expectedEntry: f.read() }] }
        : { activeSessionKey: f.scope.sessionKey, upserts: f.upserts }),
      maintenanceOverride: {
        ...f.maintenanceOverride,
        ...(drift.removalOnly ? { maxEntries: 1 } : {}),
      },
      onLifecycleCommitted: committed,
    });
    // Keep providers registered through settlement; each case asserts the original outcome.
    await Promise.allSettled([operation]);
    expect(committed).toHaveBeenCalledTimes(drift.commits ? 1 : 0);
    if (drift.removalOnly) {
      expect(changed).toHaveBeenCalled();
    } else {
      expect(changed).toHaveBeenCalledOnce();
    }
    return operation;
  } finally {
    stopPreserving();
  }
}

it("moves lifecycle counts and snapshot writes off the host while preserving maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    replaceSessionEntrySync(
      { ...f.scope, sessionKey: f.siblingKey },
      {
        ...f.read(f.siblingKey)!,
        displayName: "Archived sibling",
        createdAt: 17,
        skillsSnapshot: { prompt: "archived saved prompt", skills: [] },
      },
    );
    const publications = new Map<string, ReturnType<typeof readPreparedSessionEntryChange>>();
    const stop = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change) {
        const publication = readPreparedSessionEntryChange(change, change.sessionKey);
        if (publication) {
          publications.set(change.sessionKey, publication);
        }
      }
    });
    const sql = observeHostDataSql();
    try {
      const result = await applySessionEntryLifecycleMutation({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        upserts: f.upserts,
        maintenanceOverride: f.maintenanceOverride,
      });
      expect(result).toMatchObject({
        beforeCount: 2,
        afterCount: 3,
        archived: 1,
        capArchived: 1,
        capped: 1,
        pruned: 0,
        removedEntries: 0,
      });
      const movedQueries = sql.queries.filter(
        (query) =>
          /\bcount\s*\(\s*\*\s*\)[\s\S]*\bfrom\s+"?session_nodes\b/i.test(query) ||
          /\b(?:delete\s+from|insert\s+into|update)\s+"?session_entry_snapshots\b/i.test(query),
      );
      expect(movedQueries).toEqual([]);
      expect(publications.get(f.scope.sessionKey)?.entry).toMatchObject({
        sessionId: f.initial.sessionId,
        createdAt: f.initial.createdAt,
        createdActor: f.initial.createdActor,
      });
      expect(publications.get(f.siblingKey)?.entry).toMatchObject({
        displayName: "Archived sibling",
        createdAt: 17,
        archivedAt: expect.any(Number),
        archiveReason: "active-session-cap",
      });
    } finally {
      sql.restore();
      stop();
    }
    expect(f.read()?.skillsSnapshot).toEqual(f.upserts[0].entry.skillsSnapshot);
    expect(f.read()).toMatchObject({
      createdAt: f.initial.createdAt,
      createdVia: f.initial.createdVia,
      createdActor: f.initial.createdActor,
    });
    expect(f.read()?.sessionDiffBaseline).toBeUndefined();
    expect(f.read(f.siblingKey)).toMatchObject({ archiveReason: "active-session-cap" });
    expect(f.read(f.siblingKey)?.skillsSnapshot?.prompt).toBe("archived saved prompt");
    expect(f.read(f.createdKey)).toMatchObject({ sessionId: "new-session" });
  });
});

it("does not classify another operation's conflict as retryable reply initialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const snapshot = await loadReplySessionInitializationSnapshot(f.scope);
    const conflict = new SqliteSessionMutationConflictError("unrelated operation");
    await expect(
      commitReplySessionInitialization({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        expectedRevision: snapshot.revision,
        sessionEntry: { ...f.initial, label: "must not commit" },
        beforeEntryMutation() {
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);
    expect(f.read()).toEqual(snapshot.currentEntry);
  });
});

it("retains conflict identity and the concurrent row when a prepared upsert is stale", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const concurrent = { ...f.initial, label: "concurrent winner" };
    let expected = f.read();
    const buildEntry = vi.fn(() => ({ ...f.initial, label: "stale replacement" }));
    const committed = vi.fn();
    const operation = applySessionEntryLifecycleMutation({
      ...f.scope,
      skipMaintenance: true,
      upserts: [{ sessionKey: f.scope.sessionKey, buildEntry }],
      onLifecycleCommitted: committed,
      withCommit: async (run) => {
        replaceSessionEntrySync(f.scope, concurrent);
        expected = f.read();
        return run(() => {});
      },
    });
    await expect(operation).rejects.toBeInstanceOf(SessionEntryLifecycleUpsertConflictError);
    await expect(operation).rejects.toMatchObject({ sessionKey: f.scope.sessionKey });
    expect(buildEntry).toHaveBeenCalledOnce();
    expect(committed).not.toHaveBeenCalled();
    expect(f.read()).toEqual(expected);
  });
});

it.each(["transaction", "commit"] as const)(
  "rolls back snapshots at the %s grant",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const before = f.read();
      const refusal = new Error("lifecycle authority revoked");
      const committed = vi.fn();
      let live = true;
      let revokedAtGrant = false;
      probe.admission(admission, (request, grant, callback) => {
        if (delivery.currentCommand === "session.lifecycle.project" && request.stage === stage) {
          live = false;
          revokedAtGrant = true;
        }
        callback(request, grant);
      });
      const operation = applySessionEntryLifecycleMutation({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        skipMaintenance: true,
        upserts: [{ sessionKey: f.scope.sessionKey, entry: { sessionId: "vetoed", updatedAt: 2 } }],
        commitGuard: () => {
          if (!live) {
            throw refusal;
          }
        },
        onLifecycleCommitted: committed,
      });
      await expect(operation).rejects.toBe(refusal);
      expect(revokedAtGrant).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      expect(f.read()).toEqual(before);
    });
  },
);

it.each([
  "provider key",
  "lifecycle session id",
  "work session id",
  "work normalized key",
  "removal unrelated key",
] as const)("rolls back snapshots when maintenance protection rejects %s", async (identityKind) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    const removalOnly = identityKind === "removal unrelated key";
    if (removalOnly) {
      replaceSessionEntrySync({ ...f.scope, sessionKey: f.createdKey }, f.upserts[1].entry);
    }
    const before = [f.read(), f.read(f.siblingKey), f.read(f.createdKey)];
    let preserve = removalOnly ? [f.siblingKey] : [];
    const release = createDeferredCore();
    let lifecycle: Promise<void> | undefined;
    let work: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    delivery.beforeCommand = async (type) => {
      if (type === "session.lifecycle.project" && identityKind.startsWith("work ")) {
        work = await beginSessionWorkAdmission({
          scope: f.scope.storePath,
          identities: [
            identityKind === "work session id" ? ` ${f.siblingId} ` : " AGENT:MAIN:LIFECYCLE-OLD ",
          ],
          assertAllowed: () => {},
        });
      }
    };
    try {
      const operation = runMaintenanceDrift(f, {
        removalOnly,
        preserve: () => preserve,
        change: () => {
          if (removalOnly || identityKind === "provider key") {
            preserve = removalOnly ? [f.siblingKey, "agent:main:unrelated"] : [f.siblingKey];
          } else if (identityKind === "lifecycle session id") {
            lifecycle = runExclusiveSessionLifecycleMutation("patch", {
              scope: f.scope.storePath,
              identities: [` ${f.siblingId} `],
              run: () => release.promise,
            });
            expect(isSessionLifecycleMutationActive(f.scope.storePath, [f.siblingId])).toBe(true);
          }
        },
      });
      await expect(operation).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
      await expect(operation).rejects.toThrow(
        "SQLite session state changed while preparing session maintenance",
      );
      expect([f.read(), f.read(f.siblingKey), f.read(f.createdKey)]).toEqual(before);
    } finally {
      work?.release();
      release.resolve();
      await lifecycle;
    }
  });
});

it.each([
  {
    name: "commits when unrelated maintenance protection changes before the commit grant",
    disappears: false,
    removalOnly: false,
  },
  {
    name: "ignores protection that disappeared before the commit grant",
    disappears: true,
    removalOnly: false,
  },
  {
    name: "allows removal-only reclamation when protection disappeared",
    disappears: true,
    removalOnly: true,
  },
])("$name", async ({ disappears, removalOnly }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    if (removalOnly) {
      replaceSessionEntrySync({ ...f.scope, sessionKey: f.createdKey }, f.upserts[1].entry);
    }
    const siblingBefore = f.read(f.siblingKey);
    let preserve = disappears ? [f.siblingKey] : ["agent:main:unrelated-old"];
    const operation = runMaintenanceDrift(f, {
      commits: true,
      removalOnly,
      preserve: () => preserve,
      change: () => {
        preserve = disappears ? [] : ["agent:main:unrelated-new"];
      },
    });
    await expect(operation).resolves.toMatchObject({
      beforeCount: removalOnly ? 3 : 2,
      afterCount: removalOnly ? 2 : 3,
      archived: 1,
      capArchived: 1,
      capped: 1,
      pruned: 0,
      removedEntries: removalOnly ? 1 : 0,
    });
    if (removalOnly) {
      expect(f.read()).toBeUndefined();
    } else {
      expect(f.read()?.skillsSnapshot).toEqual(f.upserts[0].entry.skillsSnapshot);
    }
    expect(f.read(f.createdKey)).toMatchObject({ sessionId: "new-session" });
    if (disappears) {
      expect(f.read(f.siblingKey)).toEqual(siblingBefore);
      expect(f.read(f.createdKey)).toMatchObject({ archiveReason: "active-session-cap" });
    } else {
      expect(f.read(f.siblingKey)).toMatchObject({ archiveReason: "active-session-cap" });
    }
  });
});

it("publishes the acknowledged lifecycle once after losing its worker reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const createdKey = "agent:main:lifecycle-acknowledged";
    const order: string[] = [];
    const committed = vi.fn(() => order.push("committed"));
    const buildEntry = vi.fn(() => ({ sessionId: "acknowledged", updatedAt: Date.now() }));
    const lostReply = vi.fn();
    delivery.afterCommit = (type) => {
      if (type === "session.lifecycle.project") {
        lostReply();
        throw new Error("worker reply lost after COMMIT");
      }
    };
    const stop = onSessionIdentityMutation((change) => {
      if (change.kind === "create" && change.current.sessionKeys.includes(createdKey)) {
        order.push("identity");
      }
    });
    try {
      await expect(
        applySessionEntryLifecycleMutation({
          ...f.scope,
          skipMaintenance: true,
          upserts: [{ sessionKey: createdKey, buildEntry }],
          onLifecycleCommitted: committed,
        }),
      ).resolves.toMatchObject({ beforeCount: 1, afterCount: 2 });
      expect(f.read(createdKey)?.sessionId).toBe("acknowledged");
      expect(lostReply).toHaveBeenCalledOnce();
      expect(buildEntry).toHaveBeenCalledOnce();
      expect(committed).toHaveBeenCalledOnce();
      expect(order).toEqual(["committed", "identity"]);
    } finally {
      stop();
    }
  });
});
