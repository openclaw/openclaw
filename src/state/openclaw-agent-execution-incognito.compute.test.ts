import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { IncognitoComputeTarget } from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import { resolveUsageCostPricingFingerprint } from "../infra/session-cost-usage-pricing-context.js";
import {
  prepareUsageCostWorker,
  runUsageCostWorker,
} from "../infra/session-cost-usage-worker-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let otherActor: IncognitoAgentDatabaseExecution;
let otherWorker: Worker;
let env: NodeJS.ProcessEnv;
let sql: ReturnType<typeof observeHostDataSql>;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-compute-") };
  const posted = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const opened = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env,
      authority,
    });
    const other = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "other",
      env,
      authority,
    });
    assert(opened && other);
    actor = opened;
    otherActor = other;
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
  await Promise.all([actor?.close(), otherActor?.close()]);
  await closeOpenClawStateDatabaseAsync();
});

function location(owner = actor) {
  const agentId = owner === otherActor ? "other" : "main";
  return { agentId, path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }) };
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
async function hold(owner = actor) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = owner.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { release, held };
}

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

it("joins compute cleanup when its borrowed reference is released during preparation", async () => {
  const target = await create("released-compute");
  await append(target, "private borrowed frame");
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: location(actor).agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  expect(borrowed.identity).toEqual(actor.identity);
  const ready = createDeferredCore();
  const resume = createDeferredCore();
  const sourceId = "released-source";
  const computation = borrowed.sessions.withCompute(authority, target, async (compute) => {
    await compute.execute({ type: "session.compute.source.open", input: { ...target, sourceId } });
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
  });
  void computation.catch(ready.reject);
  const rejected = expect(computation).rejects.toThrow("Incognito execution reference is released");
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
});

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
  const withCompute = actor.sessions.withCompute;
  const wrapped = vi
    .spyOn(actor.sessions, "withCompute")
    .mockImplementation((caller, selected, operation, signal) =>
      withCompute(
        caller,
        selected,
        (compute) =>
          operation({
            assertCurrent: compute.assertCurrent,
            async execute(command) {
              const result = await compute.execute(command);
              if (command.type === "session.compute.projection.appendChunk") {
                appendedChunk = true;
                current = false;
              }
              return result;
            },
          }),
        signal,
      ),
    );
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
  await expect(
    actor.sessions.history(authority, {
      type: "session.history.recent",
      input: { ...target, options: { maxMessages: 10 } },
    }),
  ).rejects.toThrow("projection is rebuilding");
  await expect(
    reconcileSessionTranscriptIndexes(
      { agentId: location(actor).agentId, path: location(actor).path, env },
      { actor, authority, target },
    ),
  ).resolves.toEqual({ reconciledSessions: 1 });
  await expect(
    actor.sessions.history(authority, {
      type: "session.history.recent",
      input: { ...target, options: { maxMessages: 10 } },
    }),
  ).resolves.toMatchObject({
    totalMessages: 1,
    messages: [{ content: [{ type: "text", text: "current branch" }] }],
  });
});

it("ends queued compute with the typed error when its actor is lost", async () => {
  const target = await create("actor-loss", otherActor);
  const barrier = await hold(otherActor);
  const outcome = Promise.resolve()
    .then(() =>
      otherActor.sessions.withCompute(authority, target, (compute) =>
        compute.execute({ type: "session.compute.usage.stats", input: { ...target, request: {} } }),
      ),
    )
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
