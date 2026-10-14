import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../config/sessions/session-actor-memory-publication.test-support.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { buildUsageOverview } from "../shared/usage-overview.js";
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
import { resolveZstdCodec } from "./zstd-codec.js";

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

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const sessionKey = "agent:main:dashboard:incognito-usage";
const sessionId = "usage-1";
const env = { OPENCLAW_STATE_DIR: "/synthetic/phase-e-usage" };
afterEach(() => {
  memorySessionActorOwners.reset();
});

async function fixture(
  entry: Partial<InternalSessionEntry> = {},
  target = { sessionKey, sessionId },
) {
  const { sessionKey: fixtureSessionKey, sessionId: fixtureSessionId } = target;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const binding = await acquireSessionActorStorage(
    { agentId: "main", storePath, sessionKey: fixtureSessionKey, env },
    { lifetime: { assertCurrent() {}, assertReadable() {} }, authority, create: true },
  );
  if (!binding) {
    throw new Error("Production acquisition did not select memory storage");
  }
  const { actor } = binding;
  const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath })!;
  expect(
    await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId: fixtureSessionId, updatedAt: 1, ...entry },
          cwd: "/synthetic",
        },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed" });
  let next = 0;
  const append = async (
    input: number,
    cost = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  ) => {
    const id = `assistant-${++next}`;
    expect(
      await actor.appendTranscriptEvent(
        {
          commandId: id,
          phaseId: "turn",
          append: {
            kind: "metadata",
            input: {
              scope: {
                agentId: "main",
                sessionKey: fixtureSessionKey,
                sessionId: fixtureSessionId,
                storePath: binding.path,
              },
              event: {
                type: "message",
                id,
                parentId: null,
                timestamp: "2026-10-01T12:00:00.000Z",
              },
              message: {
                messageJson: JSON.stringify({
                  role: "assistant",
                  content: "answer",
                  usage: {
                    input,
                    output: 2,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: input + 2,
                    cost,
                  },
                }),
                cwd: "/synthetic",
                validateTurn: false,
              },
              options: { appendIntent: "active-branch" },
            },
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
  };
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    storePath: binding.path,
    sessionId: fixtureSessionId,
  });
  return { owner, actor, binding, append, sessionFile };
}

async function cachedFixture(target = { sessionKey, sessionId }) {
  const cached = await fixture({}, target);
  await cached.append(5);
  await runSessionActorUsage(
    cached.binding,
    { kind: "refresh", pricingFingerprint: "fixture" },
    () => undefined,
  );
  const [snapshot] = await cached.actor.storage!.read(
    {
      type: "session.usage.snapshot",
      input: { sessionIds: [target.sessionId], includeRollupBodies: true },
    },
    authority,
  );
  const entry =
    snapshot?.rollup &&
    decodeUsageCostRollup(snapshot.rollup.valueJson, "fixture", snapshot.rollup.blob ?? null);
  if (!entry) {
    throw new Error("Expected a production-generated usage rollup");
  }
  return { ...cached, entry, sessionId: target.sessionId };
}

function paddedRollup(entry: UsageCostRollupEntry, bytes: number, compressed = false) {
  const rollup = structuredClone(entry);
  rollup.rollup.untimestamped.tools = [{ name: "x".repeat(bytes), count: 1 }];
  const encoded = encodeUsageCostRollup(rollup);
  if (compressed) {
    return encoded;
  }
  const raw = Buffer.from(JSON.stringify(rollup.rollup));
  const envelope = decodeUsageCostRollupEnvelope(encoded.valueJson);
  if (!envelope) {
    throw new Error("Expected generated usage envelope");
  }
  return {
    valueJson: JSON.stringify({
      ...envelope,
      body: { ...envelope.body, encoding: "identity", storedBytes: raw.byteLength },
    }),
    blob: Uint8Array.from(raw),
  };
}

async function writeRollup(
  cached: Awaited<ReturnType<typeof cachedFixture>>,
  rollup: ReturnType<typeof paddedRollup>,
) {
  expect(
    await cached.actor.storage!.mutate(
      {
        type: "session.usage.write",
        input: { sessionId: cached.sessionId, rollup: { ...rollup, updatedAt: 1 } },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed", value: true });
}

function memoryReport(
  cached: Awaited<ReturnType<typeof fixture>>,
  sessionFiles = [cached.sessionFile],
) {
  return runSessionActorUsage(
    cached.binding,
    {
      kind: "sessions",
      pricingFingerprint: "fixture",
      sessions: sessionFiles.map((sessionFile) => ({ sessionFile })),
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    },
    () => undefined,
  );
}

describe("actor memory usage", () => {
  it.each(["valid", "missing", "truncated", "corrupt", "oversized-header"] as const)(
    "defers an oversized current body or repairs %s cache data through the actor owner",
    async (mode) => {
      const cached = await cachedFixture();
      const encoded = paddedRollup(cached.entry, mode === "corrupt" ? 16 : 2 * 1024 * 1024);
      if (mode === "missing") {
        encoded.blob = new Uint8Array();
      } else if (mode === "truncated") {
        encoded.blob = encoded.blob.slice(1);
      } else if (mode === "corrupt") {
        encoded.blob = encoded.blob.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
      } else if (mode === "oversized-header") {
        encoded.valueJson = JSON.stringify({
          ...decodeUsageCostRollupEnvelope(encoded.valueJson),
          padding: "x".repeat(70 * 1024),
        });
      }
      await writeRollup(cached, encoded);
      const report = await memoryReport(cached);
      if (mode === "valid") {
        expect(report.kind === "sessions" && report.summaries[0] === null).toBe(true);
      }
      expect(report).toMatchObject({
        kind: "sessions",
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
      expect(
        await runSessionActorUsage(
          cached.binding,
          {
            kind: "refresh",
            pricingFingerprint: "fixture",
            sessionFiles: [cached.sessionFile],
            rebuildRows: report.invalidRows,
          },
          () => undefined,
        ),
      ).toEqual({ kind: "refresh", changed: mode !== "valid" });
      if (mode !== "valid") {
        expect(await memoryReport(cached)).toMatchObject({
          summaries: [{ input: 5, output: 2 }],
          cacheStatus: { status: "fresh", staleFiles: 0 },
          invalidRows: [],
        });
      } else {
        await cached.append(7);
        expect(await memoryReport(cached)).toMatchObject({
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
    await writeRollup(cached, encoded);
    for (let index = 1; index < 40; index++) {
      const next = await cachedFixture({
        sessionKey: `${sessionKey}-${index}`,
        sessionId: `budget-${index}`,
      });
      await writeRollup(next, paddedRollup(next.entry, 900 * 1024));
      sessionFiles.push(next.sessionFile);
    }
    const snapshot = await cached.actor.storage!.read(
      {
        type: "session.usage.snapshot",
        input: {
          includeRollupBodies: true,
          reportBudget: {
            remainingBytes: 32 * 1024 * 1024 - 40 * 256,
            metadataLimit: 40,
            pricingFingerprint: "fixture",
          },
        },
      },
      authority,
    );
    expect(
      snapshot.reduce(
        (bytes, { rollup }) =>
          bytes + (rollup ? 2 * rollup.valueJson.length + (rollup.blob?.byteLength ?? 0) : 0),
        40 * 256,
      ),
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(snapshot.filter(({ rollup }) => rollup?.blob)).toHaveLength(36);
    const report = await memoryReport(cached, sessionFiles);
    expect(report).toMatchObject({
      kind: "sessions",
      summaries: Array(40).fill(null),
      staleSessionFiles: [],
      invalidRows: [],
      cacheStatus: { status: "partial", staleFiles: 0, pendingFiles: 40, cachedFiles: 0 },
    });
  });

  it.skipIf(!resolveZstdCodec())(
    "defers compressed expansion within the same report allowance",
    async () => {
      const cached = await cachedFixture();
      const encoded = paddedRollup(cached.entry, 33 * 1024 * 1024, true);
      expect(encoded.blob.byteLength).toBeLessThan(1024 * 1024);
      await writeRollup(cached, encoded);
      const report = await memoryReport(cached);
      expect(report.kind === "sessions" && report.summaries[0] === null).toBe(true);
      expect(report).toMatchObject({
        kind: "sessions",
        summaries: [null],
        staleSessionFiles: [],
        invalidRows: [],
        cacheStatus: { status: "partial", staleFiles: 0 },
      });
    },
  );

  it.each(["valid", "missing", "truncated"] as const)(
    "preserves freshness or repairs %s bodies after header allowance exhaustion",
    async (mode) => {
      const cached = await cachedFixture();
      if (mode !== "valid") {
        const encoded = encodeUsageCostRollup(cached.entry);
        await writeRollup(cached, {
          ...encoded,
          blob: mode === "missing" ? new Uint8Array() : encoded.blob.slice(1),
        });
      }
      const snapshot = await cached.actor.storage!.read(
        {
          type: "session.usage.snapshot",
          input: {
            includeRollupBodies: true,
            reportBudget: { remainingBytes: 128, metadataLimit: 1, pricingFingerprint: "fixture" },
          },
        },
        authority,
      );
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
      expect(
        await runSessionActorUsage(
          cached.binding,
          { kind: "refresh", pricingFingerprint: "fixture" },
          () => undefined,
        ),
      ).toEqual({ kind: "refresh", changed: mode !== "valid" });
      if (mode === "valid") {
        const scope = new AsyncWorkScope();
        scope.beginClose(new Error("report cancelled"));
        await expect(scope.run(() => memoryReport(cached))).rejects.toThrow("report cancelled");
        await scope.drain();
      }
    },
  );

  it("reports publication failure while keeping the refreshed usage rollup", async () => {
    const { binding, append, sessionFile } = await fixture();
    await append(5);
    const refresh = () =>
      runSessionActorUsage(
        binding,
        { kind: "refresh", pricingFingerprint: "fixture" },
        () => undefined,
      );
    const stop = failSessionActorMemoryPublication(sessionKey);
    try {
      await expect(refresh()).rejects.toMatchObject({ name: "SessionActorStorageCommittedError" });
    } finally {
      stop();
    }
    expect(await refresh()).toEqual({ kind: "refresh", changed: false });
    expect(
      await runSessionActorUsage(
        binding,
        {
          kind: "sessions",
          pricingFingerprint: "fixture",
          sessions: [{ sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        },
        () => undefined,
      ),
    ).toMatchObject({ kind: "sessions", summaries: [{ input: 5, output: 2 }] });
  });

  it("uses production memory acquisition and refreshes a stale report after an in-process append", async () => {
    const { binding, append, sessionFile } = await fixture();
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
    const refresh = () =>
      runSessionActorUsage(
        binding,
        { kind: "refresh", pricingFingerprint: "fixture" },
        () => undefined,
      );
    const report = () =>
      runSessionActorUsage(
        binding,
        {
          kind: "sessions",
          pricingFingerprint: "fixture",
          sessions: [{ sessionFile }],
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        },
        () => undefined,
      );
    expect(await refresh()).toEqual({ kind: "refresh", changed: true });
    expect(await report()).toMatchObject({
      kind: "sessions",
      summaries: [{ input: 5, output: 2 }],
      cacheStatus: { staleFiles: 0 },
    });
    await append(7);
    expect(await report()).toMatchObject({ kind: "sessions", cacheStatus: { staleFiles: 1 } });
    expect(await refresh()).toEqual({ kind: "refresh", changed: true });
    expect(await report()).toMatchObject({
      kind: "sessions",
      summaries: [{ input: 12, output: 4 }],
      cacheStatus: { staleFiles: 0 },
    });
    expect(await refresh()).toEqual({ kind: "refresh", changed: false });
  });

  it("includes all selected memory sessions in overview totals before limiting rows", async () => {
    const first = await fixture();
    const secondTarget = {
      sessionKey: "agent:main:dashboard:incognito-usage-second",
      sessionId: "usage-2",
    };
    const second = await fixture({}, secondTarget);
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
    await expect(runUsageCostWorker(prepared, { kind: "refresh", sessionFiles })).resolves.toEqual({
      kind: "refresh",
      changed: true,
    });
    const cached = await runUsageCostWorker(prepared, {
      kind: "sessions",
      pricingFingerprint,
      sessions: sessionFiles.map((sessionFile) => ({ sessionFile })),
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    expect(cached).toMatchObject({
      kind: "sessions",
      cacheStatus: { status: "fresh", cachedFiles: 2 },
    });
    if (cached.kind !== "sessions") {
      throw new Error("Expected selected memory usage summaries");
    }
    expect(
      buildUsageOverview({
        rows: [
          { sessionKey, sessionId, sessionFile: first.sessionFile },
          { ...secondTarget, sessionFile: second.sessionFile },
        ].map((target, index) => ({
          key: target.sessionKey,
          sessionId: target.sessionId,
          agentId: "main",
          updatedAt: 10_000,
          usage: cached.summaries[index] ?? null,
        })),
        options: { limit: 1 },
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
    ).toMatchObject({
      totals: { totalTokens: 20, totalCost: 2 },
      sessions: [{ usage: { totalTokens: 10, totalCost: 1 } }],
      overview: { total: 2, selectedRowCount: 2, limit: 1 },
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
    expect(
      await runUsageCostWorker(prepared, {
        kind: "sessions",
        pricingFingerprint: "fixture",
        sessions: [
          {
            sessionFile: formatSqliteSessionFileMarker({
              agentId: "main",
              storePath: databasePath,
              sessionId,
            }),
          },
        ],
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      }),
    ).toMatchObject({ kind: "sessions", summaries: [null] });
    expect(memorySessionActorOwners.list()).toEqual([]);
  });

  it("keeps captured corpus and usage bytes detached while later writes update new reads", async () => {
    const { actor, binding, append } = await fixture();
    await append(5);
    const refresh = () =>
      runSessionActorUsage(
        binding,
        { kind: "refresh", pricingFingerprint: "fixture" },
        () => undefined,
      );
    await refresh();
    const store = actor.storage!;
    const snapshotInput = {
      includeEvents: true,
      includeRollupBodies: true,
      reportBudget: {
        remainingBytes: 1024 * 1024,
        metadataLimit: 1,
        pricingFingerprint: "fixture",
      },
    };
    const before = await store.read(
      { type: "session.usage.snapshot", input: snapshotInput },
      authority,
    );
    const corpus = await store.read(
      { type: "session.corpus.list", input: { options: {} } },
      authority,
    );
    expect(corpus).toMatchObject([
      { sessionKey, sessionId, artifactKind: "active-session", sessionKind: "interactive" },
    ]);
    await append(7);
    await refresh();
    const after = await store.read(
      { type: "session.usage.snapshot", input: snapshotInput },
      authority,
    );
    expect(after[0]!.stats.eventCount).toBe(before[0]!.stats.eventCount + 1);
    expect(before[0]!.events?.some(({ eventJson }) => eventJson.includes("assistant-2"))).toBe(
      false,
    );
    for (const [snapshot, input] of [
      [before, 5],
      [after, 12],
    ] as const) {
      const rollup = snapshot[0]?.rollup;
      const entry =
        rollup && decodeUsageCostRollup(rollup.valueJson, "fixture", rollup.blob ?? null);
      expect(Object.values(entry?.rollup.buckets ?? {})[0]?.totals.input).toBe(input);
    }
    expect(
      (await store.read({ type: "session.corpus.list", input: { options: {} } }, authority))[0]!
        .contentRevision,
    ).not.toBe(corpus[0]!.contentRevision);
    await expect(
      runSessionActorUsage(
        binding,
        {
          kind: "inventory",
          sessionFiles: [
            formatSqliteSessionFileMarker({ agentId: "other", storePath: "/other", sessionId }),
          ],
        },
        () => undefined,
      ),
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
    expect(
      await store.mutate(
        {
          type: "session.collaboration.participant",
          input: { params: { identity: { type: "profile", id: "profile-1" }, promptedAt: 2 } },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    await runWithSessionActorStorage(binding, async () => {
      expect(
        await resolveMemorySessionTargetsInWorker({ agentId: "main", participants: ["profile-1"] }),
      ).toMatchObject([
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
      expect(
        await resolveMemorySessionTargetsInWorker({
          agentId: "main",
          sessionIds: [sessionKey],
          since: 10,
        }),
      ).toEqual([]);
    });
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    expect(
      await store.mutate(
        {
          type: "session.lifecycle.reset",
          input: {
            expected,
            nextEntry: { ...expected!, sessionId: "usage-2", sessionStartedAt: 20, updatedAt: 20 },
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    const current = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    await runWithSessionActorStorage({ ...binding, actor: current }, async () => {
      expect(
        await resolveMemorySessionTargetsInWorker({ agentId: "main", hookSources: ["webhook"] }),
      ).toMatchObject([
        { sessionId: "usage-1", createdAt: 1 },
        { sessionId: "usage-2", createdAt: 20 },
      ]);
      expect(
        await resolveMemorySessionTargetsInWorker({
          agentId: "main",
          sessionIds: [sessionKey],
          since: 10,
        }),
      ).toMatchObject([{ sessionId: "usage-2", createdAt: 20 }]);
    });
  });
});
