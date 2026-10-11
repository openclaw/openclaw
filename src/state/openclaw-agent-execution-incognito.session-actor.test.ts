import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "./openclaw-agent-execution-incognito.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
let execution: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

useIncognitoNoHostSql();

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-session-actor-") };
  execution = await openIncognitoTestActor(env, authority);
});

afterAll(async () => {
  await execution.close();
  await closeOpenClawStateDatabaseAsync();
});

it("shares the memory owner while fencing both legacy and phase snapshots without extending expiry", async () => {
  const sessionKey = "agent:main:dashboard:incognito-phase-receipts";
  await execution.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "phase-receipts", incognito: true, updatedAt: 100 },
  });
  const expiry = execution.sessions.deadlines()[0]?.expiresAt;
  const old = await execution.sessions.read(authority, { sessionKey });
  await expect(
    execution.sessionActors.acquire(
      {
        database: { ...execution.identity, incarnation: "another-owner" },
        sessionKey,
      },
      execution,
    ),
  ).rejects.toThrow("differs from its memory owner");
  const actor = await execution.sessionActors.acquire(
    { database: execution.identity, sessionKey },
    execution,
  );
  const before = await actor.read(authority);
  const result = await actor.patch(
    {
      commandId: "update-activity",
      phaseId: "turn",
      expected: before.version,
      reducers: [{ kind: "activity", updatedAt: 200 }],
    },
    { assertCurrent: () => old.claim.assertCurrent(), authorize() {} },
  );
  expect(result.kind).toBe("committed");
  expect((await actor.read(authority)).entry?.updatedAt).toBe(200);
  expect(() => execution.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
  expect(() => old.snapshot.assertCurrent()).toThrow("pending or unavailable");
  expect((await execution.sessions.read(authority, { sessionKey })).entry?.updatedAt).toBe(200);
  expect(() => old.snapshot.assertCurrent()).toThrow("snapshot changed");
  expect(execution.sessions.deadlines()[0]?.expiresAt).toBe(expiry);

  const stale = await actor.read(authority);
  const legacy = await withIncognitoSessionActor(execution, () =>
    patchSessionEntryCore(
      {
        agentId: "main",
        sessionKey,
        storePath: execution.path,
        env,
      },
      () => ({ updatedAt: 300 }),
    ),
  );
  const fresh = await actor.read(authority);
  expect(legacy?.updatedAt).toBeGreaterThanOrEqual(300);
  expect(fresh.entry?.updatedAt).toBe(legacy?.updatedAt);
  expect(fresh.version.epoch).not.toBe(stale.version.epoch);
  const refused = await actor.patch(
    {
      commandId: "stale-activity",
      phaseId: "turn",
      expected: stale.version,
      reducers: [{ kind: "activity", updatedAt: 400 }],
    },
    authority,
  );
  expect(refused.kind).toBe("stale-version");
  expect((await actor.read(authority)).entry?.updatedAt).toBe(legacy?.updatedAt);

  const denied = await actor.patch(
    {
      commandId: "revoked-activity",
      phaseId: "turn",
      expected: (await actor.read(authority)).version,
      reducers: [{ kind: "activity", updatedAt: 500 }],
    },
    {
      assertCurrent() {},
      authorize(stage) {
        if (stage === "commit") {
          throw new Error("phase authority revoked");
        }
      },
    },
  );
  expect(denied.kind).toBe("rolled-back");
  expect((await actor.read(authority)).entry?.updatedAt).toBe(legacy?.updatedAt);
  await actor.release();
});

it("retains sibling replicas across legacy work and writes from a stale postimage without a read", async () => {
  const firstKey = "agent:main:dashboard:incognito-scoped-first";
  const secondKey = "agent:main:dashboard:incognito-scoped-second";
  for (const [sessionKey, sessionId] of [
    [firstKey, "scoped-first"],
    [secondKey, "scoped-second"],
  ] as const) {
    await execution.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, incognito: true, updatedAt: 10 },
    });
  }
  const first = await execution.sessionActors.acquire(
    { database: execution.identity, sessionKey: firstKey },
    execution,
  );
  const second = await execution.sessionActors.acquire(
    { database: execution.identity, sessionKey: secondKey },
    execution,
  );
  try {
    const initial = await first.patch(
      { commandId: "cold-first", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 20 }] },
      authority,
    );
    if (initial.kind !== "committed") {
      throw new Error("Expected cold first command to commit");
    }
    const beforeSecond = await second.read(authority);
    expect(first.snapshot(authority)).toEqual(initial.receipt.postimage);
    await execution.sessions.read(authority, { sessionKey: secondKey });
    expect(first.snapshot(authority)).toEqual(initial.receipt.postimage);
    await withIncognitoSessionActor(execution, () =>
      patchSessionEntryCore(
        { agentId: "main", sessionKey: secondKey, storePath: execution.path, env },
        () => ({ label: "legacy second" }),
      ),
    );
    expect(first.snapshot(authority)).toEqual(initial.receipt.postimage);
    expect(second.snapshot(authority)).toBeUndefined();
    expect(
      (
        await first.patch(
          {
            commandId: "warm-first",
            phaseId: "turn",
            expected: initial.receipt.afterVersion,
            reducers: [{ kind: "activity", updatedAt: 30 }],
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const stale = await second.patch(
      {
        commandId: "stale-second",
        phaseId: "turn",
        expected: beforeSecond.version,
        reducers: [{ kind: "activity", updatedAt: 40 }],
      },
      authority,
    );
    if (stale.kind !== "stale-version") {
      throw new Error("Expected same-command refresh after legacy write");
    }
    expect(stale.postimage.entry?.label).toBe("legacy second");
    expect(second.snapshot(authority)).toEqual(stale.postimage);
    expect(
      (
        await second.patch(
          {
            commandId: "retry-second",
            phaseId: "turn",
            expected: stale.postimage.version,
            reducers: [{ kind: "activity", updatedAt: 40 }],
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
  } finally {
    await first.release();
    await second.release();
  }
});

it("retains a phase through borrow release without holding the command FIFO across an await", async () => {
  const borrowed = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-phase-lifetime";
  await borrowed.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "phase-lifetime", incognito: true, updatedAt: 100 },
  });
  const actor = await borrowed.sessionActors.acquire(
    { database: borrowed.identity, sessionKey },
    borrowed,
  );
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const phase = actor.withPhase("retained", authority, async (held) => {
    held.patch([{ kind: "activity", updatedAt: 600 }]);
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  // This uses the same native owner while the retained phase is suspended.
  expect((await execution.sessions.read(authority, { sessionKey })).entry?.updatedAt).toBe(100);
  const releasing = borrowed.release();
  finish.resolve();
  const settled = await Promise.allSettled([phase, releasing]);
  expect(settled[1].status).toBe("fulfilled");
  expect((await execution.sessions.read(authority, { sessionKey })).entry?.updatedAt).toBe(600);
  expect(() => actor.assertReadable()).toThrow("released");
});

it("rechecks the factory caller lifetime before commit and disclosure", async () => {
  const sessionKey = "agent:main:dashboard:incognito-caller-lifetime";
  await execution.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "caller-lifetime", incognito: true, updatedAt: 100 },
  });
  let current = true;
  let readable = true;
  const actor = await execution.sessionActors.acquire(
    { database: execution.identity, sessionKey },
    {
      assertCurrent() {
        if (!current) {
          throw new Error("caller current revoked");
        }
      },
      assertReadable() {
        if (!readable) {
          throw new Error("caller disclosure revoked");
        }
      },
    },
  );
  try {
    const before = await actor.read(authority);
    const result = await actor.patch(
      {
        commandId: "caller-lifetime",
        phaseId: "turn",
        expected: before.version,
        reducers: [{ kind: "activity", updatedAt: 900 }],
      },
      {
        assertCurrent() {},
        authorize(stage) {
          if (stage === "commit") {
            current = false;
          }
        },
      },
    );
    expect(result.kind).toBe("rolled-back");
    current = true;
    expect((await actor.read(authority)).entry?.updatedAt).toBe(100);
    readable = false;
    expect(() => actor.snapshot(authority)).toThrow("caller disclosure revoked");
    await expect(actor.read(authority)).rejects.toThrow("caller disclosure revoked");
  } finally {
    current = true;
    readable = true;
    await actor.release();
  }
});

it.each(["metadata", "event"] as const)(
  "reconciles a committed %s branch before return without rewriting its durable receipt",
  async (form) => {
    const sessionKey = `agent:main:dashboard:incognito-actor-projection-${form}`;
    const sessionId = `actor-projection-${form}`;
    await execution.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, incognito: true, updatedAt: 100 },
    });
    const actor = await execution.sessionActors.acquire(
      { database: execution.identity, sessionKey },
      execution,
    );
    try {
      for (const id of ["first-model", "replacement-model"]) {
        const before = await actor.read(authority);
        const eventJson = JSON.stringify({
          type: "model_change",
          id,
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          provider: "synthetic",
          modelId: "test-model",
        });
        const result = await actor.appendTranscriptEvent(
          {
            commandId: id,
            phaseId: "model",
            expected: before.version,
            ...(form === "metadata"
              ? {
                  append: {
                    kind: "metadata" as const,
                    input: {
                      scope: { agentId: "main", sessionKey, sessionId, storePath: execution.path },
                      event: eventJson,
                      options: {},
                    },
                  },
                }
              : {
                  sessionId,
                  lifecycleRevision: before.entry?.lifecycleRevision ?? null,
                  eventJson,
                }),
          },
          authority,
        );
        expect(result.kind).toBe("committed");
        if (result.kind !== "committed") {
          throw new Error("Expected committed metadata append");
        }
        expect(result.failure).toBeUndefined();
        expect(result.value).toMatchObject(
          form === "metadata"
            ? {
                kind: "metadata",
                value: { projectionNeedsReconcile: false },
              }
            : { projectionNeedsReconcile: false },
        );
        if (id === "replacement-model") {
          expect(result.receipt.transcript.projectionNeedsReconcile).toBe(true);
          if (form === "metadata") {
            expect(result.receipt.transcript.append?.value.projectionNeedsReconcile).toBe(true);
          }
        }
      }
      const ready = await actor.read(authority);
      expect(ready.transcript.anchorsState).toBe("resident");
      // Model-selection metadata changes the branch but contributes no model messages.
      expect(ready.transcript.modelContext).toEqual({
        kind: "resident",
        entries: [],
      });
    } finally {
      await actor.release();
    }
  },
);
