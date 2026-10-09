import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type {
  IncognitoComputeOperations,
  IncognitoComputeTarget,
} from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { readSessionTranscriptIndexStatus } from "../config/sessions/session-transcript-projection-writer.js";
import * as reconcilePool from "../config/sessions/session-transcript-reconcile-pool.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-transcript-reconcile.js";
import { isSessionCostUsageRefreshRunning } from "../infra/session-cost-usage-cache.sqlite.js";
import { resolveUsageCostPricingFingerprint } from "../infra/session-cost-usage-pricing-context.js";
import {
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../infra/session-cost-usage-reporting.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../infra/session-cost-usage-worker-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerIncognitoComputeWiringTests } from "./openclaw-agent-execution-incognito.compute-wiring.test-support.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  useIncognitoActorProbe,
  useIncognitoNoHostSql,
} from "./openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const probe = useIncognitoActorProbe();
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-compute-") };
  actor = await captureActor("main");
});
useIncognitoNoHostSql();
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function captureActor(agentId: string, options?: { existingOnly: true }) {
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId,
    env,
    authority,
    ...options,
  });
  assert(opened);
  return opened;
}

function location(owner = actor) {
  return { agentId: owner.agentId, path: owner.path };
}

async function create(sessionId: string, owner = actor): Promise<IncognitoComputeTarget> {
  const sessionKey = `agent:${location(owner).agentId}:dashboard:incognito-${sessionId}`;
  const created = await owner.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId,
      createdAt: 10_000,
      updatedAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
    },
  });
  assert(created.entry);
  return { sessionKey, sessionId, lifecycleRevision: created.entry.lifecycleRevision };
}
function append(
  target: IncognitoComputeTarget,
  content: string,
  owner = actor,
  parentId?: string | null,
) {
  return owner.sessions.transcript(authority, {
    type: "session.message.append",
    input: {
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      fence: { expectedLifecycleRevision: target.lifecycleRevision },
      parentId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: content }],
        timestamp: 10_000,
        provider: "test",
        model: "test",
        usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
      },
    },
  });
}
async function branch(target: IncognitoComputeTarget): Promise<IncognitoComputeTarget> {
  const sessionId = `${target.sessionId}-next`;
  const result = await actor.sessions.transcript(authority, {
    type: "session.manager.transcript.branch",
    input: {
      sessionKey: target.sessionKey,
      command: {
        type: "session.transcript.branch",
        input: {
          scope: { ...target, agentId: "main", storePath: actor.path },
          branch: { sessionId, events: [] },
          expectedLifecycleRevision: target.lifecycleRevision,
        },
      },
    },
  });
  assert(result.ok);
  return { ...target, sessionId };
}
function marker(target: IncognitoComputeTarget, owner = actor) {
  return formatSqliteSessionFileMarker({
    agentId: location(owner).agentId,
    storePath: location(owner).path,
    sessionId: target.sessionId,
  });
}
function prepare(owner = actor) {
  return prepareUsageCostWorker({
    agentId: location(owner).agentId,
    databasePath: location(owner).path,
    storePath: location(owner).path,
    agentDir: path.dirname(location(owner).path),
    config: {},
    env,
  });
}
function usage(
  target: IncognitoComputeTarget,
  operation: Parameters<typeof runUsageCostWorker>[1],
  owner = actor,
  grant = authority,
) {
  return runUsageCostWorker(prepare(owner), operation, { actor: owner, authority: grant, target });
}
function stats(target: IncognitoComputeTarget, owner = actor) {
  return owner.sessions.withCompute(authority, target, (compute) =>
    compute.execute({
      type: "session.compute.usage.stats",
      input: { ...target, request: {} },
    }),
  );
}
function recentHistory(target: IncognitoComputeTarget) {
  return actor.sessions.history(authority, {
    type: "session.history.recent",
    input: { ...target, options: { maxMessages: 10 } },
  });
}
function observeCompute(observe: (type: keyof IncognitoComputeOperations) => void | Promise<void>) {
  const withCompute = actor.sessions.withCompute;
  return vi
    .spyOn(actor.sessions, "withCompute")
    .mockImplementation((caller, selected, operation, signal, onRead) =>
      withCompute(
        caller,
        selected,
        (compute) =>
          operation({
            assertCurrent: compute.assertCurrent,
            async execute(command) {
              const result = await compute.execute(command);
              await observe(command.type);
              return result;
            },
          }),
        signal,
        onRead,
      ),
    );
}
async function hold(owner = actor) {
  const barrier = probe.hold(owner, authority);
  await barrier.entered.promise;
  return barrier;
}

it("composes empty and multi-session store compute without holding its actor FIFO", () =>
  withIncognitoSessionActor(actor, async () => {
    await expect(runUsageCostWorker(prepare(), { kind: "inventory" })).resolves.toEqual({
      kind: "inventory",
      files: [],
    });
    await expect(reconcileSessionTranscriptIndexes({ ...location(), env })).resolves.toEqual({
      reconciledSessions: 0,
    });
    expect(await readSessionTranscriptIndexStatus({ ...location(), env })).toBe(false);
    // Clean headers sort before the dirty targets and exceed one maintenance batch.
    for (let index = 0; index < 129; index++) {
      await create(`admission-${String(index).padStart(3, "0")}`);
    }
    const first = await create("store-first");
    const second = await create("store-second");
    for (const target of [first, second]) {
      await append(target, "old branch");
      await append(target, `current ${target.sessionId}`, actor, null);
    }
    await expect(
      reconcileSessionTranscriptIndexes({
        ...location(),
        env,
        preferredSessionId: second.sessionId,
      }),
    ).resolves.toEqual({ reconciledSessions: 2 });
    for (const target of [first, second]) {
      await expect(recentHistory(target)).resolves.toMatchObject({
        totalMessages: 1,
        messages: [{ content: [{ type: "text", text: `current ${target.sessionId}` }] }],
      });
    }
    const sessionFiles = [marker(first), marker(second)];
    const inventory = await runUsageCostWorker(prepare(), { kind: "inventory" });
    expect(inventory).toMatchObject({
      kind: "inventory",
      files: expect.arrayContaining(
        sessionFiles.map((sourcePath) => expect.objectContaining({ sourcePath })),
      ),
    });
    await expect(
      runUsageCostWorker(prepare(), { kind: "inventory", sessionFiles: [] }),
    ).resolves.toEqual({ kind: "inventory", files: [] });
    await expect(
      runUsageCostWorker(prepare(), { kind: "inventory", minMtimeMs: Number.MAX_SAFE_INTEGER }),
    ).resolves.toEqual({ kind: "inventory", files: [] });
    await expect(
      runUsageCostWorker(prepare(), {
        kind: "inventory",
        sessionFiles,
        minMtimeMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toMatchObject({
      kind: "inventory",
      files: expect.arrayContaining(
        sessionFiles.map((sourcePath) => expect.objectContaining({ sourcePath })),
      ),
    });
    await expect(runUsageCostWorker(prepare(), { kind: "refresh", sessionFiles })).resolves.toEqual(
      { kind: "refresh", changed: true },
    );
    const prepared = prepare();
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      prepared.config,
      prepared.agentDir,
    );
    await expect(
      runUsageCostWorker(prepared, {
        kind: "sessions",
        pricingFingerprint,
        sessions: sessionFiles.map((sessionFile) => ({ sessionFile })),
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
    ).resolves.toMatchObject({
      kind: "sessions",
      summaries: [
        { totalTokens: 10, totalCost: 1 },
        { totalTokens: 10, totalCost: 1 },
      ],
      cacheStatus: { status: "fresh", cachedFiles: 2 },
    });
  }));

it("refuses new compute work through a released borrow", async () => {
  const target = await create("released-borrow");
  const reference = await captureActor("main", { existingOnly: true });
  await reference.release();
  const operation = vi.fn(async () => "late compute");
  await expect(
    Promise.resolve().then(() => reference.sessions.withCompute(authority, target, operation)),
  ).rejects.toThrow("Incognito execution reference is released");
  expect(operation).not.toHaveBeenCalled();
});

it("captures the selected compute target before accepting deferred work", async () => {
  const selected = await create("captured-target");
  const replacement = await create("replacement-target");
  await append(selected, "selected transcript");
  const target = { ...selected };
  const read = actor.sessions.withCompute(authority, target, (compute) =>
    compute.execute({
      type: "session.compute.usage.stats",
      input: { ...selected, request: {} },
    }),
  );
  Object.assign(target, replacement);
  await expect(read).resolves.toMatchObject({ eventCount: 2 });
});

describe("cross-actor compute", () => {
  let otherActor: IncognitoAgentDatabaseExecution;
  let otherWorker: Worker;

  beforeAll(async () => {
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    try {
      otherActor = await captureActor("other");
      const index = posted.mock.calls.findIndex(
        ([request]) =>
          isRecord(request) &&
          request.type === "open" &&
          request.databasePath === location(otherActor).path,
      );
      const worker: unknown = posted.mock.contexts[index];
      assert(worker instanceof Worker);
      otherWorker = worker;
    } finally {
      posted.mockRestore();
    }
  });
  afterAll(async () => {
    await otherActor?.close();
  });

  it("reconciles actor transcripts rewritten while yielding to a smaller backlog", async ({
    signal,
  }) => {
    const first = await create("yield-large-first");
    const targets = [first];
    for (const name of ["second", "third", "fourth"]) {
      targets.push(await create(`yield-large-${name}`));
    }
    for (const target of targets) {
      await append(target, "old branch");
      await append(target, "current branch", actor, null);
    }
    const small = await create("yield-small", otherActor);
    await append(small, "small branch", otherActor);
    const paused = createDeferredCore();
    const release = createDeferredCore();
    const queued = createDeferredCore();
    const completed: string[] = [];
    let held = false;
    const wrapped = observeCompute(async (type) => {
      if (type === "session.compute.projection.finalize" && !held) {
        held = true;
        // Native finalization has committed; the planner has not received its ACK.
        paused.resolve();
        await release.promise;
      }
    });
    const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
    const scheduled = vi
      .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
      .mockImplementation((generation, run, owner) =>
        runOperation(
          generation,
          (operation) =>
            run({
              ...operation,
              startTask: (...args) => {
                const pending = operation.startTask(...args);
                if (args[0].mode === "memory" && args[0].sessionIds.includes(small.sessionId)) {
                  queued.resolve();
                }
                return pending;
              },
            }),
          owner,
        ),
      );
    const large = reconcileSessionTranscriptIndexes(
      { ...location(), env, preferredSessionId: first.sessionId },
      { actor, authority },
    ).then((result) => {
      completed.push("large");
      return result;
    });
    let smaller: ReturnType<typeof reconcileSessionTranscriptIndexes> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(paused.promise, large, "large rebuild ended before its pause"),
        signal,
      );
      smaller = reconcileSessionTranscriptIndexes(
        { ...location(otherActor), env },
        { actor: otherActor, authority, target: small },
      ).then((result) => {
        completed.push("small");
        return result;
      });
      await withinTest(
        awaitGateBeforeSettlement(queued.promise, smaller, "small rebuild ended before admission"),
        signal,
      );
      await append(first, "rewritten while yielding", actor, null);
      release.resolve();
      await withinTest(Promise.all([large, smaller]), signal);
      expect(completed).toEqual(["small", "large"]);
      await expect(
        actor.sessions.withCompute(authority, first, (compute) =>
          compute.execute({ type: "session.compute.status", input: first }),
        ),
      ).resolves.toBe(false);
      await expect(recentHistory(first)).resolves.toMatchObject({
        totalMessages: 1,
        messages: [{ content: [{ type: "text", text: "rewritten while yielding" }] }],
      });
    } finally {
      release.resolve();
      await Promise.allSettled([large, smaller]);
      scheduled.mockRestore();
      wrapped.mockRestore();
    }
  });

  it("isolates equal session IDs and refuses foreign actor bindings and forged usage markers", async () => {
    const own = await create("shared-id");
    const foreign = await create("shared-id", otherActor);
    await append(own, "own usage");
    await append(foreign, "foreign usage", otherActor);
    await append(foreign, "another foreign event", otherActor);
    const ownStats = await stats(own);
    const foreignStats = await stats(foreign, otherActor);
    assert(ownStats && foreignStats);
    expect(foreignStats.eventCount).toBe(ownStats.eventCount + 1);
    for (const [target, owner] of [
      [own, actor],
      [foreign, otherActor],
    ] as const) {
      await expect(usage(target, { kind: "inventory" }, owner)).resolves.toMatchObject({
        kind: "inventory",
        files: [{ sourcePath: marker(target, owner), sessionId: "shared-id" }],
      });
    }
    await expect(
      runUsageCostWorker(
        prepare(),
        { kind: "inventory" },
        { actor: otherActor, authority, target: foreign },
      ),
    ).rejects.toThrow("Usage actor does not own the prepared database");
    await expect(
      usage(own, { kind: "inventory", sessionFiles: [marker(foreign, otherActor)] }),
    ).rejects.toThrow("Usage request contains another incognito session");
    await expect(
      actor.sessions.withCompute(authority, own, (compute) =>
        compute.execute({
          type: "session.compute.usage.cache",
          input: { ...own, request: { filePaths: [marker(foreign, otherActor)] } },
        }),
      ),
    ).rejects.toThrow("another transcript");
  });

  it("ends queued compute with the typed error when its actor is lost", async () => {
    const target = await create("actor-loss", otherActor);
    const barrier = await hold(otherActor);
    const outcome = Promise.resolve()
      .then(() => stats(target, otherActor))
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await otherWorker.terminate();
    } finally {
      barrier.release.resolve();
      await Promise.allSettled([barrier.held]);
    }
    expect(await outcome).toMatchObject({ error: { code: "INCOGNITO_SESSION_ENDED" } });
  });
});

registerIncognitoComputeWiringTests({
  get actor() {
    return actor;
  },
  get env() {
    return env;
  },
  authority,
  create,
  append,
  branch,
  marker,
});

it("reads explicit retained usage windows and preserves their discovery", async () => {
  const previous = await create("usage-retained");
  await append(previous, "retained usage");
  const current = await branch(previous);
  await append(current, "current usage");
  const incognito = { actor, authority };
  const inventory = await runUsageCostWorker(prepare(), { kind: "inventory" }, incognito);
  assert(inventory.kind === "inventory");
  expect(inventory.files.map((file) => file.sourcePath)).toContain(marker(current));
  expect(inventory.files.map((file) => file.sourcePath)).toContain(marker(previous));
  await withEnvAsync(env, async () => {
    const params = { agentId: "main", sessionFile: marker(previous), incognito };
    expect(await loadSessionCostSummary(params)).toMatchObject({ totalTokens: 10, totalCost: 1 });
    expect(await loadSessionLogs(params)).toMatchObject([
      { content: "retained usage", tokens: 10 },
    ]);
    expect(await loadSessionUsageTimeSeries(params)).toMatchObject({
      points: [{ totalTokens: 10 }],
    });
  });
});

it("observes a pending actor append before usage inventory, stats and rollup publication", async () => {
  const target = await create("fifo");
  const before = await stats(target);
  assert(before);
  const barrier = await hold();
  try {
    const written = append(target, "committed usage");
    const inventory = usage(target, { kind: "inventory" });
    const readStats = stats(target);
    barrier.release.resolve();
    const [result, files, after] = await Promise.all([written, inventory, readStats, barrier.held]);
    assert(result.ok && after);
    expect(after.eventCount).toBe(before.eventCount + 1);
    expect(files).toEqual({
      kind: "inventory",
      files: [
        {
          kind: "sqlite",
          sourcePath: marker(target),
          sessionId: target.sessionId,
          mtimeMs: after.lastMutationAtMs,
        },
      ],
    });
    await expect(usage(target, { kind: "refresh" })).resolves.toEqual({
      kind: "refresh",
      changed: true,
    });
    const prepared = prepare();
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      prepared.config,
      prepared.agentDir,
    );
    await expect(
      usage(target, {
        kind: "sessions",
        pricingFingerprint,
        sessions: [{ sessionId: target.sessionId, sessionFile: marker(target) }],
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
    ).resolves.toMatchObject({
      kind: "sessions",
      summaries: [{ totalTokens: 10, totalCost: 1 }],
      cacheStatus: { status: "fresh", cachedFiles: 1 },
    });
  } finally {
    barrier.release.resolve();
    await barrier.held;
  }
});

it("preserves explicit empty inventory and applies the cutoff only to discovery", async () => {
  const target = await create("inventory-selection");
  await append(target, "selected usage");
  const all = await usage(target, { kind: "inventory" });
  assert(all.kind === "inventory" && all.files.length === 1);
  const minMtimeMs = all.files[0]!.mtimeMs + 1;
  for (const operation of [
    { kind: "inventory" as const, sessionFiles: [] },
    { kind: "inventory" as const, minMtimeMs },
  ]) {
    await expect(usage(target, operation)).resolves.toEqual({ kind: "inventory", files: [] });
  }
  await expect(
    usage(target, { kind: "inventory", sessionFiles: [marker(target)], minMtimeMs }),
  ).resolves.toEqual(all);
});

it.each(["transaction", "commit"] as const)(
  "refuses usage disclosure denied at %s",
  async (deniedStage) => {
    const target = await create(`denied-${deniedStage}`);
    await append(target, "private usage");
    const stages: string[] = [];
    await expect(
      usage(target, { kind: "inventory" }, actor, {
        assertCurrent() {},
        authorize(stage, facts) {
          expect(facts.identity).toEqual(actor.identity);
          expect(facts.sessionKey).toBe(target.sessionKey);
          stages.push(stage);
          if (stage === deniedStage) {
            throw new Error("usage disclosure denied");
          }
        },
      }),
    ).rejects.toThrow("usage disclosure denied");
    expect(stages).toContain(deniedStage);
  },
);

it("reclaims exact compute sources and refresh locks after caller revocation", async () => {
  const target = await create("revoked-cleanup");
  await append(target, "private compute frame");
  const sourceId = "revoked-source";
  const lockJson = JSON.stringify({
    pid: process.pid,
    startedAt: 1,
    ownerNonce: "revoked-refresh",
  });
  let current = true;
  const grant = {
    assertCurrent() {
      if (!current) {
        throw new Error("compute caller revoked");
      }
    },
  };
  await expect(
    actor.sessions.withCompute(grant, target, async (compute) => {
      await compute.execute({
        type: "session.compute.source.open",
        input: { ...target, sourceId },
      });
      const frame = await compute.execute({
        type: "session.compute.source.read",
        input: { ...target, sourceId },
      });
      expect(frame.type).toBe("source-frame");
      expect(
        await compute.execute({
          type: "session.compute.usage.acquireLock",
          input: {
            ...target,
            request: { previousRaw: null, previousOwnerIsRunning: false, lockJson, startedAt: 1 },
          },
        }),
      ).toBe(true);
      current = false;
      return frame;
    }),
  ).rejects.toThrow("compute caller revoked");
  await actor.sessions.withCompute(authority, target, async (compute) => {
    await compute.execute({ type: "session.compute.source.open", input: { ...target, sourceId } });
    expect(
      await compute.execute({
        type: "session.compute.usage.refreshLock",
        input: { ...target, request: {} },
      }),
    ).toBeNull();
    expect(
      await compute.execute({
        type: "session.compute.usage.acquireLock",
        input: {
          ...target,
          request: { previousRaw: null, previousOwnerIsRunning: false, lockJson, startedAt: 1 },
        },
      }),
    ).toBe(true);
  });
});

it("keeps overlapping scopes' sources and refresh lock cleanup separate", async () => {
  const target = await create("overlapping-compute");
  await append(target, "held by the first scope");
  const sourceId = "shared-source";
  const request = {
    previousRaw: null,
    previousOwnerIsRunning: false,
    lockJson: JSON.stringify({ pid: process.pid, startedAt: 1, ownerNonce: "shared-lock" }),
    startedAt: 1,
  };
  await actor.sessions.withCompute(authority, target, async (first) => {
    await first.execute({ type: "session.compute.source.open", input: { ...target, sourceId } });
    expect(
      await first.execute({
        type: "session.compute.usage.acquireLock",
        input: { ...target, request },
      }),
    ).toBe(true);
    const held = await first.execute({
      type: "session.compute.usage.refreshLock",
      input: { ...target, request: {} },
    });
    expect(held).not.toBeNull();
    expect(
      await isSessionCostUsageRefreshRunning("main", actor.path, { actor, authority, target }),
    ).toBe(true);

    await actor.sessions.withCompute(authority, target, async (second) => {
      await second.execute({ type: "session.compute.source.open", input: { ...target, sourceId } });
      expect(
        await second.execute({
          type: "session.compute.usage.acquireLock",
          input: { ...target, request },
        }),
      ).toBe(false);
    });
    expect(
      await first.execute({ type: "session.compute.source.read", input: { ...target, sourceId } }),
    ).toMatchObject({ type: "source-frame" });
    expect(
      await first.execute({
        type: "session.compute.usage.refreshLock",
        input: { ...target, request: {} },
      }),
    ).toBe(held);
  });
});

it.each([false, true])(
  "joins compute cleanup after borrow release (whole store: %s)",
  async (wholeStore) => {
    const target = await create(`released-compute-${wholeStore}`);
    await append(target, "private borrowed frame");
    const borrowed = await captureActor(location(actor).agentId, { existingOnly: true });
    expect(borrowed.identity).toEqual(actor.identity);
    const ready = createDeferredCore();
    const resume = createDeferredCore();
    const sourceId = "released-source";
    const computation = borrowed.sessions.withCompute(
      authority,
      wholeStore ? undefined : target,
      async (compute) => {
        await compute.execute({
          type: "session.compute.source.open",
          input: { ...target, sourceId },
        });
        const frame = await compute.execute({
          type: "session.compute.source.read",
          input: { ...target, sourceId },
        });
        expect(
          await compute.execute({
            type: "session.compute.usage.acquireLock",
            input: {
              ...target,
              request: {
                previousRaw: null,
                previousOwnerIsRunning: false,
                lockJson: "released-lock",
                startedAt: 1,
              },
            },
          }),
        ).toBe(true);
        ready.resolve();
        await resume.promise;
        return frame;
      },
    );
    void computation.catch(ready.reject);
    const rejected = expect(computation).rejects.toThrow(
      "Incognito execution reference is released",
    );
    try {
      await ready.promise;
      let released = false;
      const releasing = borrowed.release().then(() => {
        released = true;
      });
      await actor.sessions.withCompute(authority, target, async (compute) => {
        expect(
          await compute.execute({
            type: "session.compute.usage.refreshLock",
            input: { ...target, request: {} },
          }),
        ).not.toBeNull();
      });
      expect(released).toBe(false);
      resume.resolve();
      await releasing;
      await rejected;
      await actor.sessions.withCompute(authority, target, async (compute) => {
        expect(
          await compute.execute({
            type: "session.compute.usage.refreshLock",
            input: { ...target, request: {} },
          }),
        ).toBeNull();
        await compute.execute({
          type: "session.compute.source.open",
          input: { ...target, sourceId },
        });
        expect(
          await compute.execute({
            type: "session.compute.source.read",
            input: { ...target, sourceId },
          }),
        ).toMatchObject({ type: "source-frame" });
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([rejected, borrowed.release()]);
    }
  },
);

it("discards revoked partial projections and reconciles the complete active actor branch", async () => {
  const target = await create("reconcile");
  await append(target, "old branch");
  const replacement = await append(target, "current branch", actor, null);
  assert(replacement.ok);
  expect(replacement.value.projectionNeedsReconcile).toBe(true);
  let current = true;
  let appendedChunk = false;
  const grant = {
    assertCurrent() {
      if (!current) {
        throw new Error("projection caller revoked");
      }
    },
  };
  const wrapped = observeCompute((type) => {
    if (type === "session.compute.projection.appendChunk") {
      appendedChunk = true;
      current = false;
    }
  });
  try {
    await expect(
      reconcileSessionTranscriptIndexes(
        { agentId: location(actor).agentId, path: location(actor).path, env },
        { actor, authority: grant, target },
      ),
    ).rejects.toThrow("projection caller revoked");
    expect(appendedChunk).toBe(true);
  } finally {
    wrapped.mockRestore();
  }
  await expect(recentHistory(target)).rejects.toThrow("projection is rebuilding");
  await expect(
    reconcileSessionTranscriptIndexes(
      { agentId: location(actor).agentId, path: location(actor).path, env },
      { actor, authority, target },
    ),
  ).resolves.toEqual({ reconciledSessions: 1 });
  await expect(recentHistory(target)).resolves.toMatchObject({
    totalMessages: 1,
    messages: [{ content: [{ type: "text", text: "current branch" }] }],
  });
});

it.each(["coalesce", "handoff"] as const)(
  "retains deferred projection and read-only readiness through %s",
  async (mode) =>
    withIncognitoSessionActor(actor, async () => {
      const target = await create(`deferred-${mode}`);
      await append(target, "old branch");
      await append(target, "first branch", actor, null);
      const database = { ...location(), env };
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const checked = createDeferredCore();
      let held = false;
      const wrapped = observeCompute(async (type) => {
        if (type === "session.compute.store.status") {
          checked.resolve();
        }
        if (type === "session.compute.source.open" && !held) {
          held = true;
          entered.resolve();
          await release.promise;
          if (mode === "handoff") {
            throw new Error("interrupted projection preparation");
          }
        }
      });
      let waiting: Promise<void> | undefined;
      try {
        startSessionTranscriptIndexReconcile(database);
        await awaitGateBeforeSettlement(
          entered.promise,
          waitForSessionTranscriptIndexReconcile(database),
          "Reconciliation settled before opening its source",
        );
        waiting = waitForSessionTranscriptProjection(
          { ...target, env, storePath: database.path },
          undefined,
        );
        await awaitGateBeforeSettlement(
          checked.promise,
          waiting,
          "Readiness settled before its actor probe",
        );
        // This append would deadlock if the deferred owner held the actor FIFO.
        await append(target, "final branch", actor, null);
        startSessionTranscriptIndexReconcile(database);
        release.resolve();
        await Promise.all([waiting, waitForSessionTranscriptIndexReconcile(database)]);
        await expect(recentHistory(target)).resolves.toMatchObject({
          totalMessages: 1,
          messages: [{ content: [{ type: "text", text: "final branch" }] }],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([waiting, waitForSessionTranscriptIndexReconcile(database)]);
        wrapped.mockRestore();
      }
    }),
);
