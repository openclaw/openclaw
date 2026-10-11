import { afterEach, describe, expect, it, vi } from "vitest";
import { openContextEngineTurnOutboxWorkerStore } from "../../agents/harness/context-engine-turn-outbox-store.js";
import { drainContextEngineTurnOutbox } from "../../agents/harness/context-engine-turn-outbox.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "../../infra/heartbeat-outcome-store.js";
import { recordMessageToolRunOutcome } from "../../infra/message-tool-run-outcome-store.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSqliteTrajectoryRuntimeSink } from "../../trajectory/runtime-store-writer.js";
import {
  loadSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { appendTranscriptMessage, upsertSessionEntryCore } from "./session-accessor.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { mutateSessionActorMemorySideEffects } from "./session-actor-memory-side-effects.js";
import { createSessionActorMemoryState } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import type { TranscriptTurnBoundary } from "./transcript-entry-anchor.js";

vi.mock("node:sqlite", async (original) => ({
  ...(await original<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory side data opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory side data allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
const env = { OPENCLAW_STATE_DIR: "/synthetic/side-data" };
const location = {
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
};
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
  memorySessionActorOwners.reset();
});

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

async function fixture(suffix = "one", owner = createMemorySessionActorOwner(location)) {
  if (!owners.includes(owner)) {
    owners.push(owner);
  }
  const sessionKey = `agent:main:dashboard:incognito-side-${suffix}`;
  const sessionId = `session-${suffix}`;
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const storage = actor.storage!;
  const binding = { ...location, actor, authority };
  const storageScope = {
    agentId: location.agentId,
    env,
    storePath: location.path,
    sessionKey,
    sessionId,
  };
  const scope = { ...storageScope, sessionActor: binding };
  committed(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: { scope: storageScope, entry: { sessionId, updatedAt: 1, incognito: true } },
      },
      authority,
    ),
  );
  const message = async (id: string, role: "user" | "assistant", text: string) => {
    committed(
      await storage.mutate(
        {
          type: "session.metadata.append",
          input: {
            scope: storageScope,
            event: {
              type: "message",
              id,
              parentId: null,
              timestamp: "2026-10-11T00:00:00.000Z",
            },
            message: {
              messageJson: JSON.stringify({ role, content: text, timestamp: 1 }),
              cwd: "/synthetic",
              validateTurn: false,
            },
            options: { appendIntent: "active-branch" },
          },
        },
        authority,
      ),
    );
    const anchor = actor.snapshot(authority)!.transcript.anchors.find((row) => row.entryId === id);
    if (!anchor) {
      throw new Error("Missing appended anchor");
    }
    return anchor;
  };
  const turn = async (id: string): Promise<TranscriptTurnBoundary> => ({
    admission: { ...(await message(`${id}-user`, "user", id)), logicalTurnId: id, role: "user" },
    terminal: await message(`${id}-assistant`, "assistant", `${id} reply`),
  });
  return { owner, actor, storage, binding, scope, message, turn };
}

function trajectory(sessionId: string, text: string, seq: number): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "runtime",
    type: "test",
    ts: "2026-10-11T00:00:00.000Z",
    seq,
    sessionId,
    runId: `run-${seq}`,
    data: { text },
  };
}

describe("memory session side-data consumers", () => {
  it("routes unbound production side data through the current memory owner without recreating closed sessions", async () => {
    const target = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: "/synthetic/phase-e-side-data" },
      sessionKey: "agent:main:dashboard:incognito-unbound-side-data",
      sessionId: "unbound-side-data",
    };
    const scope = { ...target, storePath: resolveIncognitoOpenClawAgentSqlitePath(target) };
    await upsertSessionEntryCore(scope, {
      sessionId: target.sessionId,
      updatedAt: 1,
      incognito: true,
    });
    await persistHeartbeatOutcome({
      ...scope,
      runSessionKey: scope.sessionKey,
      occurredAt: 1,
      response: { outcome: "progress", notify: false, summary: "unbound" },
    });
    expect((await claimHeartbeatOutcomeForRun({ ...scope, runId: "user" }))?.summary).toBe(
      "unbound",
    );
    const outcome = {
      ...scope,
      runId: "user",
      provider: "test",
      model: "test",
      outcome: "mute" as const,
      runStatus: "completed" as const,
      occurredAt: 1,
    };
    await recordMessageToolRunOutcome(outcome);
    const appended = await appendTranscriptMessage(scope, {
      message: { role: "user", content: "unbound turn" },
      now: 1,
    });
    if (!appended?.anchor) {
      throw new Error("Expected production transcript anchor");
    }
    const boundary: TranscriptTurnBoundary = {
      admission: { ...appended.anchor, logicalTurnId: "unbound-turn", role: "user" },
      terminal: appended.anchor,
    };
    const store = openContextEngineTurnOutboxWorkerStore({
      agentId: scope.agentId,
      path: scope.storePath,
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
    });
    const filter = { engineId: "test", isHeartbeat: false };
    await store.acceptIntent({ ...filter, boundary });
    expect(
      await store.publishClosedTurn({ ...filter, boundary, maxEvents: 10, maxBytes: 10_000 }),
    ).toBe("ok");
    expect(await store.readNextPending({ ...filter, sessionId: scope.sessionId })).toMatchObject({
      advancement_key: "unbound-turn",
    });
    await store.complete("unbound-turn");
    const event = trajectory(scope.sessionId, "unbound", 0);
    const sink = await createSqliteTrajectoryRuntimeSink({
      env: scope.env,
      sessionId: scope.sessionId,
      sessionKey: scope.sessionKey,
      sessionTarget: scope,
      maxRuntimeFileBytes: 1000,
    });
    if (!sink) {
      throw new Error("Expected unbound trajectory sink");
    }
    sink.write(event, JSON.stringify(event));
    await sink.flush();
    expect(await loadSqliteTrajectoryRuntimeEvents(scope)).toEqual([event]);
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope)).toEqual([{ event, seq: 0 }]);
    memorySessionActorOwners.closeSession(
      { agentId: scope.agentId, path: scope.storePath },
      scope.sessionKey,
    );
    await expect(recordMessageToolRunOutcome(outcome)).rejects.toThrow("incognito");
    expect(await claimHeartbeatOutcomeForRun({ ...scope, runId: "late" })).toBeUndefined();
    expect(await loadSqliteTrajectoryRuntimeEvents(scope)).toEqual([]);
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope)).toEqual([]);
    expect(
      memorySessionActorOwners
        .read({ agentId: scope.agentId, path: scope.storePath })
        ?.readSession(scope.sessionKey, authority),
    ).toBeUndefined();
  });

  it("claims heartbeat context once per run, sees replacements, and keeps returned data detached", async () => {
    const { scope, binding } = await fixture();
    await runWithSessionActorStorage(binding, () =>
      persistHeartbeatOutcome({
        ...scope,
        runSessionKey: scope.sessionKey,
        occurredAt: 1,
        response: { outcome: "progress", notify: false, summary: "first" },
        taskNames: ["task"],
      }),
    );
    const [winner, other] = await Promise.all([
      claimHeartbeatOutcomeForRun({ ...scope, runId: "run-one" }),
      claimHeartbeatOutcomeForRun({ ...scope, runId: "run-two" }),
    ]);
    expect(winner?.summary).toBe("first");
    expect(other).toBeUndefined();
    winner!.taskNames.push("mutated");
    expect((await claimHeartbeatOutcomeForRun({ ...scope, runId: "run-one" }))?.taskNames).toEqual([
      "task",
    ]);
    await persistHeartbeatOutcome({
      ...scope,
      runSessionKey: scope.sessionKey,
      occurredAt: 2,
      response: { outcome: "done", notify: false, summary: "replacement" },
    });
    expect((await claimHeartbeatOutcomeForRun({ ...scope, runId: "run-two" }))?.summary).toBe(
      "replacement",
    );
    await recordMessageToolRunOutcome({
      ...scope,
      runId: "run-two",
      provider: "test",
      model: "test",
      outcome: "mute",
      runStatus: "completed",
      occurredAt: 2,
    });
  });

  it("recovers ordered accepted turns and allows plugin callbacks to await the same actor", async () => {
    const { scope, actor, storage, binding, turn } = await fixture();
    const store = openContextEngineTurnOutboxWorkerStore({
      ...location,
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      sessionActor: binding,
    });
    const filter = { engineId: "test", isHeartbeat: false };
    const abandoned = await turn("abandoned");
    await store.enqueueIntent({ ...filter, admission: abandoned.admission });
    expect(await store.prepareRun({ ...filter, sessionId: scope.sessionId })).toMatchObject({
      pending: false,
      admitted: false,
      warnings: [expect.stringContaining("discarded unaccepted")],
    });
    const first = await turn("first");
    const second = await turn("second");
    for (const boundary of [first, second]) {
      await store.enqueueIntent({ ...filter, admission: boundary.admission });
      await store.acceptIntent({ ...filter, boundary });
    }
    expect(await store.prepareRun({ ...filter, sessionId: scope.sessionId })).toMatchObject({
      pending: true,
      admitted: false,
    });
    const calls: string[] = [];
    const engine: ContextEngine = {
      info: { id: "test", name: "test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      async commitTurn(input) {
        calls.push(input.advancementKey);
        expect(input.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        // Awaiting the same owner here would deadlock if draining held its FIFO.
        await storage.read({ type: "session.history.stats", input: {} }, authority);
        if (calls.length === 1) {
          throw new Error("retry plugin");
        }
        return { status: "committed" };
      },
    };
    const warn = vi.fn();
    expect(await drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn })).toEqual({
      pending: true,
    });
    expect(calls).toEqual(["first"]);
    expect(await drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn })).toEqual({
      pending: false,
    });
    expect(calls).toEqual(["first", "first", "second"]);
    actor.assertReadable();
    const blocked = await turn("blocked");
    await store.acceptIntent({ ...filter, boundary: blocked });
    expect(
      await store.publishClosedTurn({
        ...filter,
        boundary: blocked,
        maxEvents: 1,
        maxBytes: 100_000,
      }),
    ).toBe("too-large");
    expect(await store.hasPending(filter)).toBe(false);
  });

  it("keeps trajectory appends bounded and applies global retention without a sweep handshake", async () => {
    const first = await fixture();
    const second = await fixture("two", first.owner);
    const initial = trajectory(first.scope.sessionId, "old", 1);
    const sink = await createSqliteTrajectoryRuntimeSink({
      env: first.scope.env,
      maxRuntimeFileBytes: 1000,
      sessionId: first.scope.sessionId,
      sessionKey: first.scope.sessionKey,
      sessionTarget: first.scope,
      sessionActor: first.binding,
    });
    expect(sink).not.toBeNull();
    sink!.write(initial, JSON.stringify(initial));
    await sink!.flush();
    const read = await loadSqliteTrajectoryRuntimeEvents(first.scope);
    expect(read).toEqual([initial]);
    read[0]!.data = { text: "mutated" };
    expect(await loadSqliteTrajectoryRuntimeEvents(first.scope)).toEqual([initial]);
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ ...first.scope, maxEventCount: 0 }),
    ).rejects.toThrow("too many events");
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ ...first.scope, maxEventBytes: 1 }),
    ).rejects.toThrow("too large");
    const newer = trajectory(first.scope.sessionId, "same-session", 2);
    sink!.write(newer, JSON.stringify(newer));
    await sink!.flush();
    expect(loadSqliteTrajectoryRuntimeEventRowsSync({ ...first.scope, afterSeq: 0 })).toEqual([
      { event: newer, seq: 1 },
    ]);
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        ...first.scope,
        tailEvents: 1,
        maxEventBytes: 1,
        maxEventCount: 0,
      }),
    ).toEqual([{ event: newer, seq: 1 }]);
    committed(
      await second.storage.mutate(
        {
          type: "session.trajectory.append",
          input: {
            sessionId: second.scope.sessionId,
            events: [trajectory(second.scope.sessionId, "new", 2)],
            maxRuntimeBytes: 1000,
            maxGlobalRuntimeBytes: 1,
          },
        },
        authority,
      ),
    );
    expect(await loadSqliteTrajectoryRuntimeEvents(first.scope)).toEqual([]);
    expect(await loadSqliteTrajectoryRuntimeEvents(second.scope)).toHaveLength(1);
    const oversized = trajectory(first.scope.sessionId, "x".repeat(2000), 3);
    sink!.write(oversized, JSON.stringify(oversized));
    await sink!.flush();
    expect(await loadSqliteTrajectoryRuntimeEvents(first.scope)).toEqual([]);
  });

  it("acknowledges an already handed-off turn while its actor handle releases", async () => {
    const { scope, actor, owner, binding, turn } = await fixture();
    const boundary = await turn("closing");
    const store = openContextEngineTurnOutboxWorkerStore({
      ...location,
      sessionKey: scope.sessionKey,
      sessionActor: binding,
    });
    const filter = { engineId: "test", isHeartbeat: false };
    await store.acceptIntent({ ...filter, boundary });
    await store.publishClosedTurn({ ...filter, boundary, maxEvents: 10, maxBytes: 100_000 });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const engine: ContextEngine = {
      info: { id: "test", name: "test" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      async commitTurn() {
        entered.resolve();
        await finish.promise;
        return { status: "committed" };
      },
    };
    const drain = drainContextEngineTurnOutbox({ store, engine, engineId: "test", warn() {} });
    await entered.promise;
    const released = actor.release();
    finish.resolve();
    await expect(drain).rejects.toThrow("released");
    await released;
    const next = await owner.acquire(actor.target, { assertCurrent() {}, assertReadable() {} });
    expect(
      await next.storage!.read({ type: "session.outbox.hasPending", input: filter }, authority),
    ).toBe(false);
  });
});

it("bounds message-tool outcome rows by occurrence time and insertion order", () => {
  const sessionKey = "agent:main:dashboard:incognito-outcome-limit";
  const state = createSessionActorMemoryState({
    sessionKey,
    database: { kind: "memory", handle: "memory", incarnation: "one" },
  });
  const row = {
    run_id: "old",
    session_key: sessionKey,
    agent_id: "main",
    provider: "test",
    model: "test",
    outcome: "mute",
    run_status: "completed",
    occurred_at: 1,
  };
  state.messageToolOutcomes = Array.from({ length: 10_000 }, (_, index) => ({
    ...row,
    id: index + 1,
  }));
  const context: SessionActorMemoryStorageContext = {
    ...location,
    state,
    get: () => state,
    *entries() {
      yield [sessionKey, state];
    },
    edit: () => state,
    remove() {},
    admit() {},
    validateSources() {
      return { conversationMatches: [] };
    },
  };
  mutateSessionActorMemorySideEffects(context, {
    type: "session.messageToolOutcome.record",
    input: { ...row, run_id: "new" },
  });
  expect(state.messageToolOutcomes).toHaveLength(10_000);
  expect(state.messageToolOutcomes[0]!.id).toBe(2);
  expect(state.messageToolOutcomes.at(-1)!.run_id).toBe("new");
});
