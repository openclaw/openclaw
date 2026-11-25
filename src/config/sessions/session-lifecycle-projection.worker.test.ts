import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import { afterEach, expect, it as base, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginSessionEffect,
  isSessionMutationActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "./session-accessor.reset.js";
import { retainPreparedSessionEntryPredicate } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import type { SessionEntryLifecycleMutationParams } from "./session-accessor.sqlite-lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
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
  afterReply: undefined as ((type: string, result: unknown) => void) | undefined,
  requestBytes: [] as Array<{ type: string; bytes: number }>,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  const { decorateSessionExecutionCaptures } =
    await import("./session-execution-delivery.test-support.js");
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: decorateSessionExecutionCaptures(actual, (worker) => ({
      execute: async (command, commandOptions) => {
        delivery.requestBytes.push({
          type: command.type,
          bytes: serialize(command).byteLength,
        });
        delivery.currentCommand = command.type;
        try {
          if (delivery.beforeCommand) {
            await delivery.beforeCommand(command.type);
          }
          const result = await worker.execute(command, commandOptions);
          delivery.afterReply?.(command.type, result);
          delivery.afterCommit?.(command.type);
          return result;
        } finally {
          delivery.currentCommand = "";
        }
      },
    })).captureOpenClawAgentDatabaseExecution,
  };
});

const it = base.extend<{
  f: ReturnType<typeof fixture>;
  maintenance: ReturnType<typeof maintenanceFixture>;
}>({
  f: async ({ task: _task }, use) =>
    withOpenClawTestState({ scenario: "minimal" }, () => use(fixture())),
  maintenance: async ({ f }, use) => use(maintenanceFixture(f)),
});

afterEach(() => {
  delivery.beforeCommand = undefined;
  delivery.afterCommit = undefined;
  delivery.afterReply = undefined;
  delivery.currentCommand = "";
  delivery.requestBytes = [];
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
    database,
    scope,
    initial,
    read: (sessionKey = scope.sessionKey) => readExactSessionEntryRow(database, sessionKey)?.entry,
    mutate: (params: Omit<SessionEntryLifecycleMutationParams, "storePath">) =>
      applySessionEntryLifecycleMutation({ ...scope, skipMaintenance: true, ...params }),
  };
}

it("preserves snapshot authority during lifecycle metadata publication and revokes changed snapshots", async ({
  f,
}) => {
  const identity = readOpenClawAgentDatabaseIdentity(f.database).identity;
  const predicate = retainPreparedSessionEntryPredicate({
    databaseIdentity: `file:${identity}`,
    sessionKey: f.scope.sessionKey,
    entry: f.read(),
    projection: ["skillsSnapshot"],
    matches: (before, after) => isDeepStrictEqual(before?.skillsSnapshot, after?.skillsSnapshot),
  });
  const pending: boolean[] = [];
  delivery.afterCommit = (type) => {
    if (type === "session.lifecycle.project") {
      pending.push(predicate.isCurrent());
    }
  };
  try {
    await f.mutate({
      upserts: [
        { sessionKey: f.scope.sessionKey, entry: { ...f.read()!, displayName: "Renamed" } },
      ],
    });
    expect(pending).toEqual([true]);
    expect(predicate.isCurrent()).toBe(true);
    expect(predicate.readRetainedEntry()?.skillsSnapshot).toEqual(f.initial.skillsSnapshot);

    await f.mutate({
      upserts: [
        { sessionKey: f.scope.sessionKey, entry: { ...f.read()!, skillsSnapshot: undefined } },
      ],
    });
    expect(pending).toEqual([true, false]);
    expect(predicate.isCurrent()).toBe(false);
    expect(predicate.canRefresh()).toBe(false);
  } finally {
    predicate.release();
  }
});

it("reuses same-key reply initialization preimages without retransmitting snapshots or hiding newer writes", async ({
  f,
}) => {
  const prompt = "synthetic lifecycle instructions ".repeat(1500);
  replaceSessionEntrySync(f.scope, {
    ...f.initial,
    skillsSnapshot: { prompt, skills: [] },
  });
  const update = () =>
    f.mutate({
      upserts: [
        {
          sessionKey: f.scope.sessionKey,
          relatedSessionKeys: [f.scope.sessionKey],
          buildEntry: ({ currentEntry, readEntry }) => {
            expect(readEntry(f.scope.sessionKey)).toEqual(currentEntry);
            return { ...currentEntry!, label: "updated" };
          },
        },
      ],
    });
  await update();
  const bytes: number[] = [];
  delivery.afterReply = (type, result) => {
    if (type === "database.domain.publish") {
      bytes.push(serialize(result).byteLength);
    }
  };
  await update();
  expect(f.read()?.skillsSnapshot?.prompt).toBe(prompt);
  expect(bytes).toHaveLength(1);
  expect(bytes[0]).toBeLessThan(2000);

  delivery.beforeCommand = async (type) => {
    if (type !== "database.domain.publish") {
      return;
    }
    delivery.beforeCommand = undefined;
    replaceSessionEntrySync(f.scope, {
      ...f.read()!,
      skillsSnapshot: { prompt: "newer instructions", skills: [] },
    });
  };
  await update();
  expect(f.read()?.skillsSnapshot?.prompt).toBe("newer instructions");
});

function maintenanceFixture(f: ReturnType<typeof fixture>) {
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
    mutate: (params: Omit<SessionEntryLifecycleMutationParams, "storePath">) =>
      f.mutate({ skipMaintenance: false, ...params }),
    siblingKey,
    siblingId,
    createdKey,
    cappedEntryCounts: { archived: 1, capArchived: 1, capped: 1, pruned: 0 },
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

it("keeps upsert comparison snapshots on the host during removal planning", async ({
  maintenance: f,
}) => {
  const prompt = "synthetic lifecycle instructions ".repeat(1500);
  const resetBoundary = {
    context: "clear" as const,
    reason: "reset" as const,
    cwd: "/synthetic/workspace",
    boundaryId: "captured-reset",
  };
  replaceSessionEntrySync(f.scope, {
    ...f.initial,
    skillsSnapshot: { prompt, skills: [] },
  });
  await f.mutate({
    skipMaintenance: true,
    removals: [{ sessionKey: f.siblingKey }],
    upserts: [
      {
        sessionKey: f.scope.sessionKey,
        resetBoundary,
        entry: {
          ...f.read()!,
          label: "retained",
          skillsSnapshot: { prompt: `${prompt} updated`, skills: [] },
        },
      },
    ],
    withCommit: async (run) => {
      resetBoundary.boundaryId = "caller-mutated-reset";
      return run(() => {});
    },
  });
  const requests = delivery.requestBytes.filter(({ type }) => type === "database.domain.publish");
  expect(requests).toHaveLength(2);
  expect(Math.max(...requests.map(({ bytes }) => bytes))).toBeLessThan(
    Buffer.byteLength(prompt) + 4096,
  );
  expect(f.read()).toMatchObject({
    label: "retained",
    skillsSnapshot: { prompt: `${prompt} updated` },
  });
  expect(f.read(f.siblingKey)).toBeUndefined();
  expect(
    readTranscriptEventRows(f.database, f.initial.sessionId).map((row) =>
      JSON.parse(row.eventJson),
    ),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "reset", id: "captured-reset" })]),
  );
});

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
    const operation = f.mutate({
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

it("keeps guarded lifecycle writes and committed follow-ups off the host while preserving maintenance", async ({
  maintenance: f,
}) => {
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
  let commitAllowed = false;
  let committedFollowup = false;
  try {
    const result = await f.mutate({
      activeSessionKey: f.scope.sessionKey,
      upserts: f.upserts,
      maintenanceOverride: f.maintenanceOverride,
      beforeCommitInTransaction: () => {
        commitAllowed = true;
      },
      afterCommitted: async (context) => {
        context.assertCurrent();
        expect(commitAllowed).toBe(true);
        expect(publications.get(f.scope.sessionKey)?.entry).toMatchObject({
          sessionId: f.initial.sessionId,
          createdAt: f.initial.createdAt,
        });
        committedFollowup = true;
      },
    });
    expect(committedFollowup).toBe(true);
    expect(result).toMatchObject({
      beforeCount: 2,
      afterCount: 3,
      ...f.cappedEntryCounts,
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

for (const maxEntries of [2, 1]) {
  it(`keeps maintenance without explicit mutations on the resident writer (cap=${maxEntries})`, async ({
    maintenance: f,
  }) => {
    const reclaim = vi.spyOn(reclamation, "runSqliteSessionReclamation");
    const committed = vi.fn();
    const result = await f.mutate({
      activeSessionKey: f.scope.sessionKey,
      maintenanceOverride: { ...f.maintenanceOverride, maxEntries },
      onLifecycleCommitted: committed,
    });
    expect(result).toMatchObject({
      beforeCount: 2,
      afterCount: 2,
      capped: 2 - maxEntries,
      archived: 2 - maxEntries,
      removedEntries: 0,
    });
    expect(reclaim).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledOnce();
    expect(f.read()?.sessionId).toBe(f.initial.sessionId);
    expect(f.read(f.siblingKey)?.archiveReason).toBe(
      maxEntries === 1 ? "active-session-cap" : undefined,
    );
  });
}

it("does not classify another operation's conflict as retryable reply initialization", async ({
  f,
}) => {
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

it("retains conflict identity and the concurrent row when a prepared upsert is stale", async ({
  f,
}) => {
  const concurrent = { ...f.initial, label: "concurrent winner" };
  let expected = f.read();
  const buildEntry = vi.fn(() => ({ ...f.initial, label: "stale replacement" }));
  const committed = vi.fn();
  const operation = f.mutate({
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

for (const stage of ["transaction", "commit"] as const) {
  it(`rolls back snapshots at the ${stage} grant`, async ({ f }) => {
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
    const operation = f.mutate({
      activeSessionKey: f.scope.sessionKey,
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
}

for (const identityKind of [
  "provider key",
  "lifecycle session id",
  "work session id",
  "work normalized key",
  "removal unrelated key",
] as const) {
  it(`rolls back snapshots when maintenance protection rejects ${identityKind}`, async ({
    maintenance: f,
  }) => {
    const removalOnly = identityKind === "removal unrelated key";
    if (removalOnly) {
      replaceSessionEntrySync({ ...f.scope, sessionKey: f.createdKey }, f.upserts[1].entry);
    }
    const before = [f.read(), f.read(f.siblingKey), f.read(f.createdKey)];
    let preserve = removalOnly ? [f.siblingKey] : [];
    const release = createDeferredCore();
    let lifecycle: Promise<void> | undefined;
    let work: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
    delivery.beforeCommand = async (type) => {
      if (type === "session.lifecycle.project" && identityKind.startsWith("work ")) {
        work = await beginSessionEffect({
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
            lifecycle = runSessionMutation({
              scope: f.scope.storePath,
              identities: [` ${f.siblingId} `],
              run: () => release.promise,
            });
            expect(isSessionMutationActive(f.scope.storePath, [f.siblingId])).toBe(true);
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
}

for (const [name, disappears, removalOnly] of [
  ["commits when unrelated maintenance protection changes before the commit grant", false, false],
  ["ignores protection that disappeared before the commit grant", true, false],
  ["allows removal-only reclamation when protection disappeared", true, true],
] as const) {
  it(name, async ({ maintenance: f }) => {
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
      ...f.cappedEntryCounts,
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
}

it("publishes the acknowledged lifecycle once after losing its worker reply", async ({ f }) => {
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
      f.mutate({
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

it("reports its committed count while the next lifecycle sees later writes", async ({ f }) => {
  const createdKey = "agent:main:lifecycle-counted";
  const laterKey = "agent:main:lifecycle-later";
  await expect(
    f.mutate({
      upserts: [{ sessionKey: createdKey, entry: { sessionId: "counted", updatedAt: 2 } }],
      onLifecycleCommitted() {
        replaceSessionEntrySync(
          { ...f.scope, sessionKey: laterKey },
          { sessionId: "later", updatedAt: 3 },
        );
      },
    }),
  ).resolves.toMatchObject({ beforeCount: 1, afterCount: 2 });
  expect(f.read(laterKey)?.sessionId).toBe("later");
  const removal = await f.mutate({ removals: [{ sessionKey: createdKey }] });
  expect(removal).toMatchObject({ beforeCount: 3, afterCount: 2, removedEntries: 1 });
  expect(f.read(createdKey)).toBeUndefined();
  expect(f.read(laterKey)?.sessionId).toBe("later");
});
