import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSessionEntryWithTranscript } from "../config/sessions/session-accessor.entry-mutation.js";
import { readPreparedSessionEntryPublicationSource } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { assertSessionEntryCreationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../infra/sqlite-worker-contract.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let closingActor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;
const target = (name: string, owner = actor) => ({
  agentId: owner.agentId,
  env,
  sessionKey: `agent:${owner.agentId}:dashboard:incognito-creation-${name}`,
});

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-public-creation-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  const closing = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "closing",
    env,
    authority,
  });
  assert(opened && closing);
  actor = opened;
  closingActor = closing;
});
beforeEach(() => {
  sql = observeHostDataSql();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});
afterAll(async () => {
  await Promise.all([actor?.close(), closingActor?.close()]);
  await closeOpenClawStateDatabaseAsync();
});

it("creates the owner and transcript before publishing the public creation receipt without host SQL", async () => {
  const scope = target("publication");
  const sessionId = "publication";
  const owner = {
    actor: { type: "human" as const, id: "synthetic-creator" },
    assignedBy: { type: "system" as const, id: "fixture" },
    assignedAt: 100,
  };
  const events = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/synthetic/workspace",
    },
    {
      type: "message",
      id: "first-message",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Synthetic creation message", timestamp: 100 },
    },
  ];
  const order: string[] = [];
  let assertCreation = () => {};
  const stopFacts = sessionChanges.subscribe((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
      return;
    }
    order.push("published");
    expect(readPreparedSessionEntryPublicationSource(change)).toEqual({
      identity: actor.identity.incarnation,
      canonicalPath: actor.path,
    });
    expect(actor.sessions.readSharing(scope.sessionKey)?.entry?.owner).toEqual(owner);
    assertCreation();
  });
  const stopIdentity = onSessionIdentityMutation((change) => {
    if (change.kind === "create" && change.current.sessionKeys.includes(scope.sessionKey)) {
      order.push("identity");
    }
  });
  try {
    const created = await withIncognitoSessionActor(actor, () =>
      createSessionEntryWithTranscript(
        scope,
        async (snapshot) => {
          expect(snapshot).toMatchObject({ labelInUse: false });
          expect(snapshot.existingEntry).toBeUndefined();
          assertCreation();
          return {
            ok: true,
            entry: { sessionId, updatedAt: 100, label: "Creation fixture" },
            transcriptEvents: events,
          };
        },
        {
          label: "Creation fixture",
          resolveOwnerAssignment: () => owner,
          bindCreation(operation) {
            assertCreation = () =>
              assertSessionEntryCreationPublication(operation, {
                agentId: actor.agentId,
                sessionKey: scope.sessionKey,
                paths: new Set([actor.path]),
                databaseIdentity: actor.identity.incarnation,
              });
            assertCreation();
          },
          onLifecycleCommitted(entry) {
            expect(entry.sessionId).toBe(sessionId);
            expect(actor.sessions.readSharing(scope.sessionKey)?.entry?.owner).toEqual(owner);
            order.push("committed");
          },
          async afterCommitted(_entry, source) {
            expect(order).toEqual(["committed", "published", "identity"]);
            source.assertCurrent();
            assertCreation();
            order.push("bookkeeping");
          },
        },
      ),
    );
    expect(created).toMatchObject({ ok: true, sessionFile: scope.sessionKey });
    expect(order).toEqual(["committed", "published", "identity", "bookkeeping"]);
    expect(() => assertCreation()).toThrow("no longer current");
    const persisted = await actor.sessions.read(authority, { sessionKey: scope.sessionKey });
    expect(persisted.entry?.owner).toEqual(owner);
    const transcript = await actor.sessions.history(authority, {
      type: "session.history.hydrate",
      input: { sessionKey: scope.sessionKey, sessionId },
    });
    assert(transcript.kind === "full");
    expect(transcript.snapshot.events).toEqual(events);
  } finally {
    stopFacts();
    stopIdentity();
  }
});

it("commits and returns creation content larger than one worker message", async () => {
  const scope = target("large-prompt");
  const prompt = "s".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES + 1024);
  const summarize = (value: string | undefined) => ({
    length: value?.length,
    sha256: value === undefined ? undefined : createHash("sha256").update(value).digest("hex"),
  });
  const expected = summarize(prompt);
  const created = await withIncognitoSessionActor(actor, () =>
    createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: {
        sessionId: "large-prompt",
        updatedAt: 1,
        skillsSnapshot: { prompt, skills: [] },
      },
    })),
  );
  assert(created.ok, "Expected large actor creation to commit");
  expect(summarize(created.entry.skillsSnapshot?.prompt)).toEqual(expected);
  const persisted = await actor.sessions.read(authority, { sessionKey: scope.sessionKey });
  expect(summarize(persisted.entry?.skillsSnapshot?.prompt)).toEqual(expected);
});

it.each(["rewrite", "revocation"] as const)(
  "rejects creation after awaited %s without replacing the committed target",
  async (reason) => {
    const scope = target(reason);
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    let live = true;
    let committed = false;
    const work = withIncognitoSessionActor(actor, () =>
      createSessionEntryWithTranscript(
        scope,
        async () => {
          entered.resolve();
          await proceed.promise;
          return { ok: true, entry: { sessionId: "stale-created", updatedAt: 1 } };
        },
        {
          commitGuard() {
            if (!live) {
              throw new Error("creation authority revoked");
            }
          },
          onLifecycleCommitted() {
            committed = true;
          },
        },
      ),
    );
    const rejected = expect(work).rejects.toThrow(
      reason === "rewrite" ? /generation|snapshot changed/ : "creation authority revoked",
    );
    await entered.promise;
    if (reason === "rewrite") {
      await withIncognitoSessionActor(actor, () =>
        upsertSessionEntryCore(scope, { sessionId: "winner", label: "preserved" }),
      );
    } else {
      live = false;
    }
    proceed.resolve();
    await rejected;
    expect(committed).toBe(false);
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.sessionId,
    ).toBe(reason === "rewrite" ? "winner" : undefined);
  },
);

it("settles accepted creation after admission cancellation without cancelling its persistence", async () => {
  const scope = target("accepted");
  const cancellation = new AbortController();
  const created = await withIncognitoSessionActor(
    actor,
    () =>
      createSessionEntryWithTranscript(scope, async () => {
        cancellation.abort(new Error("scheduler close prelude"));
        return { ok: true, entry: { sessionId: "accepted", updatedAt: 1 } };
      }),
    cancellation.signal,
  );
  expect(created).toMatchObject({ ok: true, entry: { sessionId: "accepted" } });
  const persisted = await actor.sessions.read(authority, { sessionKey: scope.sessionKey });
  expect(persisted.entry?.sessionId).toBe("accepted");
  const computeTarget = {
    sessionKey: scope.sessionKey,
    sessionId: "accepted",
    lifecycleRevision: persisted.entry?.lifecycleRevision,
  };
  const stats = await actor.sessions.withCompute(authority, computeTarget, (compute) =>
    compute.execute({
      type: "session.compute.usage.stats",
      input: { ...computeTarget, request: {} },
    }),
  );
  assert(stats);
  expect(stats.lastMutationAtMs).toBeGreaterThan(1);
  expect(stats.lastObservedMutationAtMs).toBe(stats.lastMutationAtMs);
});

it("joins accepted post-commit bookkeeping before releasing the actor during close", async () => {
  const scope = target("close", closingActor);
  const entered = createDeferredCore();
  const proceed = createDeferredCore();
  const order: string[] = [];
  const creation = withIncognitoSessionActor(closingActor, () =>
    createSessionEntryWithTranscript(
      scope,
      () => ({
        ok: true,
        entry: { sessionId: "close", updatedAt: 1 },
      }),
      {
        onLifecycleCommitted() {
          order.push("committed");
        },
        async afterCommitted() {
          entered.resolve();
          await proceed.promise;
          order.push("bookkeeping");
        },
      },
    ),
  );
  const rejected = expect(creation).rejects.toThrow(/ended|current/);
  await entered.promise;
  const closing = closingActor.close().then(() => {
    order.push("closed");
  });
  proceed.resolve();
  await rejected;
  await closing;
  expect(order).toEqual(["committed", "bookkeeping", "closed"]);
});
