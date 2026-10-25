import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type {
  SessionActor,
  SessionActorAppend,
  SessionActorAuthority,
} from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../config/sessions/session-actor-memory-publication.test-support.js";
import type { SessionActorMemoryUsageReads } from "../config/sessions/session-actor-memory-usage-contract.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "../config/sessions/session-actor-storage-contract.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runSessionActorUsage } from "./session-cost-usage-memory.js";
import { resolveUsageCostPricingFingerprint } from "./session-cost-usage-pricing-context.js";
import { loadSessionLogs, loadSessionUsageTimeSeries } from "./session-cost-usage-reporting.js";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { prepareUsageCostWorker, runUsageCostWorker } from "./session-cost-usage-worker-runtime.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory usage opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory usage allocated a worker");
  }),
}));

const dayBucket = { mode: "utc-offset", utcOffsetMinutes: 0 } as const;
const runUsage = (
  binding: Parameters<typeof runSessionActorUsage>[0],
  operation: Parameters<typeof runSessionActorUsage>[1],
) => runSessionActorUsage(binding, operation, () => undefined);
const refreshUsage = (binding: Parameters<typeof runSessionActorUsage>[0]) =>
  runUsage(binding, { kind: "refresh", pricingFingerprint: "fixture" });
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const sessionKey = "agent:main:dashboard:incognito-usage";
const sessionId = "usage-1";
const env = { OPENCLAW_STATE_DIR: "/synthetic/phase-e-usage" };
const usageBudget = (remainingBytes: number, metadataLimit = 1) => ({
  remainingBytes,
  metadataLimit,
  pricingFingerprint: "fixture",
});
const resolveTargets = (
  input: Omit<Parameters<typeof resolveMemorySessionTargetsInWorker>[0], "agentId">,
) => resolveMemorySessionTargetsInWorker({ agentId: "main", ...input });
const anotherSession = (id: string) => ({ sessionKey: `${sessionKey}-${id}`, sessionId: id });
const expectReport = (report: unknown, expected: object) =>
  expect(report).toMatchObject({ kind: "sessions", ...expected });
const expectRefresh = async (refresh: Promise<unknown>, changed: boolean) =>
  expect(await refresh).toEqual({ kind: "refresh", changed });
afterEach(() => {
  memorySessionActorOwners.reset();
});

async function commit<Key extends keyof SessionActorStorageWrites>(
  actor: SessionActor,
  type: Key,
  input: SessionActorStorageWrites[Key]["input"],
  expected: object = { kind: "committed" },
) {
  expect(await actor.storage!.mutate({ type, input }, authority)).toMatchObject(expected);
}

async function fixture(
  entry: Partial<InternalSessionEntry> = {},
  target = { sessionKey, sessionId },
) {
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const binding = expectDefined(
    await acquireSessionActorStorage(
      { agentId: "main", storePath, sessionKey: target.sessionKey, env },
      { lifetime: { assertCurrent() {}, assertReadable() {} }, authority, create: true },
    ),
    "Production acquisition did not select memory storage",
  );
  const { actor } = binding;
  const scope = {
    agentId: "main",
    ...target,
    storePath: binding.path,
  };
  const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath })!;
  await commit(actor, "session.entry.create", {
    entry: { sessionId: target.sessionId, updatedAt: 1, ...entry },
    cwd: "/synthetic",
  });
  let next = 0;
  const append = async (
    input: number,
    cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  ) => {
    const id = `assistant-${++next}`;
    const message = {
      messageJson: JSON.stringify({
        role: "assistant",
        content: "answer",
        usage: { input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost },
      }),
      cwd: "/synthetic",
      validateTurn: false,
    };
    const appendInput: Extract<SessionActorAppend, { kind: "metadata" }>["input"] = {
      scope,
      message,
      event: { type: "message", id, parentId: null, timestamp: "2026-10-01T12:00:00.000Z" },
      options: { appendIntent: "active-branch" },
    };
    expect(
      await actor.appendTranscriptEvent(
        { commandId: id, phaseId: "turn", append: { kind: "metadata", input: appendInput } },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
  };
  const sessionFile = formatSqliteSessionFileMarker(scope);
  return {
    owner,
    actor,
    binding,
    append,
    sessionFile,
    ...target,
    refresh: () => refreshUsage(binding),
    report: (files = [sessionFile]) => runUsage(binding, sessionReport(files)),
    snapshot: (input: SessionActorMemoryUsageReads["session.usage.snapshot"]["input"]) =>
      actor.storage!.read({ type: "session.usage.snapshot", input }, authority),
    corpus: () =>
      actor.storage!.read({ type: "session.corpus.list", input: { options: {} } }, authority),
  };
}

async function cachedFixture(target = { sessionKey, sessionId }) {
  const cached = await fixture({}, target);
  await cached.append(5);
  await cached.refresh();
  const [snapshot] = await cached.snapshot({
    sessionIds: [target.sessionId],
    includeRollupBodies: true,
  });
  const entry =
    snapshot?.rollup &&
    decodeUsageCostRollup(snapshot.rollup.valueJson, "fixture", snapshot.rollup.blob ?? null);
  return {
    ...cached,
    entry: expectDefined(entry, "Expected a production-generated usage rollup"),
    write: (rollup: ReturnType<typeof paddedRollup>) =>
      commit(
        cached.actor,
        "session.usage.write",
        { sessionId: target.sessionId, rollup: { ...rollup, updatedAt: 1 } },
        { kind: "committed", value: true },
      ),
  };
}

function paddedRollup(entry: UsageCostRollupEntry, bytes: number) {
  const rollup = structuredClone(entry);
  rollup.rollup.untimestamped.tools = [{ name: "x".repeat(bytes), count: 1 }];
  const encoded = encodeUsageCostRollup(rollup);
  const raw = Buffer.from(JSON.stringify(rollup.rollup));
  const envelope = expectDefined(
    decodeUsageCostRollupEnvelope(encoded.valueJson),
    "Expected generated usage envelope",
  );
  return {
    valueJson: JSON.stringify({
      ...envelope,
      body: { ...envelope.body, encoding: "identity", storedBytes: raw.byteLength },
    }),
    blob: Uint8Array.from(raw),
  };
}

function sessionReport(sessionFiles: string[], pricingFingerprint = "fixture") {
  return {
    kind: "sessions",
    pricingFingerprint,
    sessions: sessionFiles.map((sessionFile) => ({ sessionFile })),
    dayBucket,
  } as const;
}

describe("actor memory usage", () => {
  it.each(["valid", "missing", "corrupt", "oversized-header"] as const)(
    "defers an oversized current body or repairs %s cache data through the actor owner",
    async (mode) => {
      const cached = await cachedFixture();
      const encoded = paddedRollup(cached.entry, mode === "corrupt" ? 16 : 2 * 1024 * 1024);
      if (mode === "missing") {
        encoded.blob = new Uint8Array();
      } else if (mode === "corrupt") {
        encoded.blob = encoded.blob.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
      } else if (mode === "oversized-header") {
        encoded.valueJson = JSON.stringify({
          ...decodeUsageCostRollupEnvelope(encoded.valueJson),
          padding: "x".repeat(70 * 1024),
        });
      }
      await cached.write(encoded);
      const report = await cached.report();
      expectReport(report, {
        summaries: [null],
        staleSessionFiles: mode === "valid" ? [] : [cached.sessionFile],
        cacheStatus: {
          status: mode === "valid" ? "partial" : "stale",
          pendingFiles: 1,
          staleFiles: mode === "valid" ? 0 : 1,
        },
      });
      if (report.kind !== "sessions") {
        throw new Error("Expected memory usage report");
      }
      expect(report.invalidRows).toHaveLength(
        mode === "valid" || mode === "oversized-header" ? 0 : 1,
      );
      await expectRefresh(
        runUsage(cached.binding, {
          kind: "refresh",
          pricingFingerprint: "fixture",
          sessionFiles: [cached.sessionFile],
          rebuildRows: report.invalidRows,
        }),
        mode !== "valid",
      );
      if (mode !== "valid") {
        expectReport(await cached.report(), {
          summaries: [{ input: 5, output: 2 }],
          cacheStatus: { status: "fresh", staleFiles: 0 },
          invalidRows: [],
        });
      } else {
        await cached.append(7);
        expectReport(await cached.report(), {
          staleSessionFiles: [cached.sessionFile],
          cacheStatus: { staleFiles: 1 },
        });
      }
    },
  );

  it("shares encoded snapshot and decoded report bytes across many individually small bodies", async () => {
    const cached = await cachedFixture();
    const encoded = paddedRollup(cached.entry, 900 * 1024);
    const sessionFiles = [cached.sessionFile];
    await cached.write(encoded);
    for (let index = 1; index < 40; index++) {
      const next = await cachedFixture(anotherSession(`budget-${index}`));
      await next.write(paddedRollup(next.entry, 900 * 1024));
      sessionFiles.push(next.sessionFile);
    }
    const snapshot = await cached.snapshot({
      includeRollupBodies: true,
      reportBudget: usageBudget(32 * 1024 * 1024 - 40 * 256, 40),
    });
    expect(
      snapshot.reduce(
        (bytes, { rollup }) =>
          bytes + (rollup ? 2 * rollup.valueJson.length + (rollup.blob?.byteLength ?? 0) : 0),
        40 * 256,
      ),
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(snapshot.filter(({ rollup }) => rollup?.blob)).toHaveLength(36);
    const report = await cached.report(sessionFiles);
    expectReport(report, {
      summaries: Array(40).fill(null),
      staleSessionFiles: [],
      invalidRows: [],
      cacheStatus: { status: "partial", staleFiles: 0, pendingFiles: 40, cachedFiles: 0 },
    });
  });

  it.each(["valid", "missing"] as const)(
    "preserves freshness or repairs %s bodies after header allowance exhaustion",
    async (mode) => {
      const cached = await cachedFixture();
      if (mode !== "valid") {
        const encoded = encodeUsageCostRollup(cached.entry);
        await cached.write({ ...encoded, blob: new Uint8Array() });
      }
      const snapshot = await cached.snapshot({
        includeRollupBodies: true,
        reportBudget: usageBudget(128),
      });
      if (mode === "valid") {
        expect(snapshot).toMatchObject([
          { rollupDeferred: true, deferredRollupMetadata: { checkpoint: { kind: "sqlite" } } },
        ]);
        expect(snapshot[0]?.deferredRollupMetadata?.checkpoint).not.toHaveProperty("anchorHash");
      } else {
        expect(snapshot[0]?.rollupDeferred).toBeUndefined();
        expect(snapshot[0]?.deferredRollupMetadata).toBeUndefined();
      }
      expect(snapshot[0]?.rollup).toBeUndefined();
      await expectRefresh(refreshUsage(cached.binding), mode !== "valid");
      if (mode === "valid") {
        const scope = new AsyncWorkScope();
        scope.beginClose(new Error("report cancelled"));
        await expect(scope.run(() => cached.report())).rejects.toThrow("report cancelled");
        await scope.drain();
      }
    },
  );

  it("releases a failed refresh for another session while keeping the committed rollup", async () => {
    const first = await fixture();
    const second = await fixture({}, anotherSession("waiting-detail"));
    await first.append(5);
    await second.append(8);
    const stop = failSessionActorMemoryPublication(sessionKey);
    let waiting: ReturnType<typeof runSessionActorUsage> | undefined;
    try {
      const refreshing = runUsage(first.binding, {
        kind: "refresh",
        pricingFingerprint: "fixture",
        sessionFiles: [first.sessionFile],
      });
      waiting = runSessionActorUsage(
        second.binding,
        {
          kind: "refresh",
          pricingFingerprint: "fixture",
          sessionFiles: [second.sessionFile],
        },
        () => undefined,
        true,
      );
      await expect(refreshing).rejects.toMatchObject({ name: "SessionActorStorageCommittedError" });
      await expect(waiting).resolves.toEqual({ kind: "refresh", changed: true });
    } finally {
      stop();
      await Promise.allSettled([waiting]);
    }
    await expectRefresh(first.refresh(), false);
    expectReport(await first.report(), { summaries: [{ input: 5, output: 2 }] });
    expectReport(await second.report(), {
      summaries: [{ totalTokens: 10 }],
      cacheStatus: { status: "fresh" },
    });
  });

  it("uses production memory acquisition and refreshes a stale report after an in-process append", async () => {
    const { binding, append, sessionFile, refresh, report } = await fixture();
    await append(5);
    {
      const prepared = prepareUsageCostWorker({ agentId: "main", storePath: binding.path, env });
      expect(prepared.databases).toEqual([]);
      expect(await runUsageCostWorker(prepared, { kind: "inventory" })).toMatchObject({
        kind: "inventory",
        files: [{ sessionId }],
      });
      const params = { agentId: "main", sessionId, sessionFile, config: {} };
      await expect(loadSessionUsageTimeSeries(params)).resolves.toMatchObject({
        sessionId,
        points: [{ input: 5, output: 2, totalTokens: 7, cost: 0.03 }],
      });
      await expect(loadSessionLogs(params)).resolves.toMatchObject([
        { role: "assistant", content: "answer", tokens: 7, cost: 0.03 },
      ]);
    }
    for (const [input, output] of [
      [5, 2],
      [12, 4],
    ]) {
      if (input === 12) {
        await append(7);
        expectReport(await report(), { cacheStatus: { staleFiles: 1 } });
      }
      await expectRefresh(refresh(), true);
      expectReport(await report(), {
        summaries: [{ input, output }],
        cacheStatus: { staleFiles: 0 },
      });
    }
    await expectRefresh(refresh(), false);
  });

  it("refreshes and reports every selected memory session through the worker adapter", async () => {
    const first = await fixture();
    const second = await fixture({}, anotherSession("usage-2"));
    const cost = { input: 0.8, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 1 };
    await first.append(8, cost);
    await second.append(8, cost);
    const prepared = prepareUsageCostWorker({
      agentId: "main",
      storePath: first.binding.path,
      env,
    });
    const sessionFiles = [first.sessionFile, second.sessionFile];
    const pricingFingerprint = await resolveUsageCostPricingFingerprint(
      prepared.config,
      prepared.agentDir,
    );
    await expectRefresh(runUsageCostWorker(prepared, { kind: "refresh", sessionFiles }), true);
    const cached = await runUsageCostWorker(
      prepared,
      sessionReport(sessionFiles, pricingFingerprint),
    );
    expectReport(cached, {
      cacheStatus: { status: "fresh", cachedFiles: 2 },
      summaries: Array.from({ length: 2 }, () => ({ totalTokens: 10, totalCost: 1 })),
    });
  });

  it("returns empty usage for an absent private owner without creating storage or borrowing a database worker", async () => {
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const prepared = prepareUsageCostWorker({ agentId: "main", databasePath, env });
    expect(prepared.databases).toEqual([]);
    expect(await runUsageCostWorker(prepared, { kind: "inventory" })).toEqual({
      kind: "inventory",
      files: [],
    });
    const file = formatSqliteSessionFileMarker({
      agentId: "main",
      storePath: databasePath,
      sessionId,
    });
    expectReport(await runUsageCostWorker(prepared, sessionReport([file])), {
      summaries: [null],
    });
    expect(memorySessionActorOwners.list()).toEqual([]);
  });

  it("keeps captured corpus and usage bytes detached while later writes update new reads", async () => {
    const { binding, append, refresh, snapshot, corpus: readCorpus } = await cachedFixture();
    const snapshotInput = {
      includeEvents: true,
      includeRollupBodies: true,
      reportBudget: usageBudget(1024 * 1024),
    };
    const before = await snapshot(snapshotInput);
    const corpus = await readCorpus();
    expect(corpus).toMatchObject([
      { sessionKey, sessionId, artifactKind: "active-session", sessionKind: "interactive" },
    ]);
    await append(7);
    await refresh();
    const after = await snapshot(snapshotInput);
    expect(after[0]!.stats.eventCount).toBe(before[0]!.stats.eventCount + 1);
    expect(before[0]!.events?.some(({ eventJson }) => eventJson.includes("assistant-2"))).toBe(
      false,
    );
    for (const [capture, input] of [
      [before, 5],
      [after, 12],
    ] as const) {
      const rollup = capture[0]?.rollup;
      const entry =
        rollup && decodeUsageCostRollup(rollup.valueJson, "fixture", rollup.blob ?? null);
      expect(Object.values(entry?.rollup.buckets ?? {})[0]?.totals.input).toBe(input);
    }
    expect((await readCorpus())[0]!.contentRevision).not.toBe(corpus[0]!.contentRevision);
    await expect(
      runUsage(binding, {
        kind: "inventory",
        sessionFiles: [
          formatSqliteSessionFileMarker({ agentId: "other", storePath: "/other", sessionId }),
        ],
      }),
    ).rejects.toThrow("another session owner");
  });

  it("selects exact source and participant facts while retaining the creation date across activity writes and reset windows", async () => {
    const { owner, actor, binding } = await fixture({
      sessionStartedAt: 1,
      hookExternalContentSource: "webhook",
      chatType: "direct",
      delivery: {
        kind: "external",
        route: { channel: "slack", target: { to: "C-fixture" } },
        context: { channel: "slack", accountId: "fixture-account" },
        origin: { provider: "slack" },
      },
    });
    const store = actor.storage!;
    await commit(actor, "session.collaboration.participant", {
      params: { identity: { type: "profile", id: "profile-1" }, promptedAt: 2 },
    });
    await runWithSessionActorStorage(binding, async () => {
      expect(await resolveTargets({ participants: ["profile-1"] })).toMatchObject([
        {
          sessionId,
          channel: "slack",
          accountId: "fixture-account",
          chatType: "direct",
          hookExternalContentSource: "webhook",
          createdAt: 1,
          participants: [{ type: "profile", id: "profile-1" }],
        },
      ]);
      await actor.patch(
        {
          commandId: "activity",
          phaseId: "turn",
          reducers: [{ kind: "activity", updatedAt: 100 }],
        },
        authority,
      );
      expect(await resolveTargets({ sessionIds: [sessionKey], since: 10 })).toEqual([]);
    });
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    await commit(actor, "session.lifecycle.reset", {
      expected,
      nextEntry: { ...expected!, sessionId: "usage-2", sessionStartedAt: 20, updatedAt: 20 },
    });
    const current = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    await runWithSessionActorStorage({ ...binding, actor: current }, async () => {
      expect(await resolveTargets({ hookSources: ["webhook"] })).toMatchObject([
        { sessionId: "usage-1", createdAt: 1 },
        { sessionId: "usage-2", createdAt: 20 },
      ]);
      expect(await resolveTargets({ sessionIds: [sessionKey], since: 10 })).toMatchObject([
        { sessionId: "usage-2", createdAt: 20 },
      ]);
    });
  });
});
