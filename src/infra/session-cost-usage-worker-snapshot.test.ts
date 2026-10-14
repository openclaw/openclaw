import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { partitionUsageCostRollup } from "./session-cost-usage-partitions.js";
import {
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_SCOPE,
  USAGE_COST_ROLLUP_VERSION,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "./session-cost-usage-totals.js";
import {
  prepareUsageCostReportEntry,
  readUsageCostReportEntry,
} from "./session-cost-usage-worker-report.js";
import { executeUsageCostWorker } from "./session-cost-usage-worker.js";
import type { UsageCostWorkerInput } from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  inventory: vi.fn<() => Promise<UsageCostTranscriptFile[]>>(),
}));

// mock-isolation: Use only the borrowed native connection, without opening real agent stores.
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  openOpenClawAgentDatabaseReadOnly: fixture.open,
  withOpenClawAgentDatabaseReadOnly: vi.fn(),
}));
// mock-isolation: Pause transcript discovery without loading the worker's retained refresh state.
vi.mock("./session-cost-usage-refresh-inputs.worker.js", () => ({
  createUsageCostCollectionAccess: () => ({
    inventory: fixture.inventory,
  }),
  usageRefreshInputs: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

it("spends the shared decoded budget on complete reports after preparing the snapshot", async () => {
  const timestamp = Date.UTC(2026, 8, 18);
  const pricingFingerprint = "synthetic-pricing";
  const entries = [17, 23].map((tokens) => {
    const rollup = createSessionUsageRollupData();
    appendSessionUsageRollupContribution(rollup, {
      timestamp,
      role: "assistant",
      toolNames: [],
      toolResultCounts: { total: 0, errors: 0 },
      usageTotals: {
        ...createEmptyCostUsageTotals(),
        input: tokens,
        totalTokens: tokens,
        inputCost: tokens / 10,
        totalCost: tokens / 10,
      },
    });
    // Untimestamped tool counts remain in the body, not its dated partitions.
    appendSessionUsageRollupContribution(rollup, {
      toolNames: Array.from({ length: 32 }, (_, index) => `synthetic-unattributed-tool-${index}`),
      toolResultCounts: { total: 0, errors: 0 },
    });
    const file: UsageCostTranscriptFile = {
      filePath: `/synthetic/report-${tokens}.jsonl`,
      sourcePath: `/synthetic/report-${tokens}.jsonl`,
      kind: "jsonl",
      size: 100,
      mtimeMs: timestamp,
      device: 1,
      inode: tokens,
    };
    const encoded = partitionUsageCostRollup({
      version: USAGE_COST_ROLLUP_VERSION,
      pricingFingerprint,
      checkpoint: {
        kind: "jsonl",
        parsedOffset: file.size,
        observedSize: file.size,
        observedMtimeMs: file.mtimeMs,
        device: file.device ?? 0,
        inode: file.inode ?? 0,
        anchorHash: "synthetic-anchor",
      },
      scannedAt: timestamp,
      parsedRecords: 1,
      countedRecords: 1,
      rollup,
    });
    const envelope = decodeUsageCostRollupEnvelope(encoded.valueJson, pricingFingerprint);
    if (!envelope) {
      throw new Error("Encoded fixture must have a valid rollup envelope");
    }
    const partitionBytes = encoded.partitions.reduce((total, partition) => {
      const metadata: { bytes: number } = JSON.parse(partition.valueJson);
      return total + metadata.bytes;
    }, 0);
    expect(envelope.body.bytes).toBeGreaterThan(partitionBytes);
    const prepared = prepareUsageCostReportEntry({
      row: { key: file.filePath, updatedAt: timestamp, valueJson: encoded.valueJson },
      body: () => encoded.blob,
      partitions: () => encoded.partitions,
      pricingFingerprint,
      throwIfCancelled() {},
    });
    return { prepared, file, decodedBytes: envelope.body.bytes + partitionBytes };
  });
  const [first, second] = entries;
  if (!first || !second) {
    throw new Error("Budget fixture requires two reports");
  }
  expect(second.decodedBytes).toBe(first.decodedBytes);
  const cacheBudget = { remainingBytes: first.decodedBytes };
  const unexpectedReplay = async () => {
    throw new Error("Committed partition fixture must not replay transcripts");
  };
  const read = (entry: (typeof entries)[number]) =>
    readUsageCostReportEntry({
      prepared: entry.prepared,
      file: entry.file,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      scan: {
        pricingFingerprint,
        resolveCosts: unexpectedReplay,
        readGeneration: unexpectedReplay,
        readRows: unexpectedReplay,
      },
      throwIfCancelled() {},
      replayBudget: { remainingBytes: 0, deadline: Number.POSITIVE_INFINITY },
      cacheBudget,
    });
  expect(await read(first)).toMatchObject({
    rollup: {
      buckets: { [String(timestamp)]: { totals: { totalTokens: 17, totalCost: 1.7 } } },
    },
  });
  expect(await read(second)).toBeNull();
});

it("ends the cache snapshot before projection awaits and preserves a concurrent write", async ({
  signal,
}) => {
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec(`CREATE TABLE cache_entries (
    scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT, blob BLOB,
    expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key)
  )`);
  const timestamp = Date.UTC(2026, 8, 18);
  const pricingFingerprint = "synthetic-pricing";
  const file: UsageCostTranscriptFile = {
    filePath: "/synthetic/report.jsonl",
    sourcePath: "/synthetic/report.jsonl",
    kind: "jsonl",
    size: 100,
    mtimeMs: timestamp,
    device: 1,
    inode: 2,
  };
  const write = (connection: DatabaseSync, tokens: number) => {
    const rollup = createSessionUsageRollupData();
    appendSessionUsageRollupContribution(rollup, {
      timestamp,
      role: "assistant",
      toolNames: [],
      toolResultCounts: { total: 0, errors: 0 },
      usageTotals: {
        ...createEmptyCostUsageTotals(),
        input: tokens,
        totalTokens: tokens,
        inputCost: tokens / 10,
        totalCost: tokens / 10,
      },
    });
    const encoded = encodeUsageCostRollup({
      version: USAGE_COST_ROLLUP_VERSION,
      pricingFingerprint,
      checkpoint: {
        kind: "jsonl",
        parsedOffset: file.size,
        observedSize: file.size,
        observedMtimeMs: file.mtimeMs,
        device: file.device ?? 0,
        inode: file.inode ?? 0,
        anchorHash: "synthetic-anchor",
      },
      scannedAt: timestamp,
      parsedRecords: 1,
      countedRecords: 1,
      rollup,
    });
    connection
      .prepare(`INSERT INTO cache_entries (scope, key, value_json, blob, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, key) DO UPDATE SET
          value_json = excluded.value_json, blob = excluded.blob, updated_at = excluded.updated_at`)
      .run(USAGE_COST_ROLLUP_SCOPE, file.filePath, encoded.valueJson, encoded.blob, timestamp);
  };
  write(db, 3);
  // Borrow one native connection so an independent job can use it while projection waits.
  fixture.open.mockReturnValue({ found: true, database: { db, close() {} } });
  const projecting = createDeferredCore();
  const resume = createDeferredCore();
  fixture.inventory.mockImplementationOnce(async () => {
    projecting.resolve();
    await resume.promise;
    return [file];
  });
  fixture.inventory.mockResolvedValue([file]);
  const input: UsageCostWorkerInput = {
    kind: "usage-cost",
    location: { agentId: "main", databasePath: ":memory:", storePath: ":memory:", env: {} },
    databases: [{ agentId: "main", path: ":memory:" }],
    archiveStorePaths: [],
    operation: {
      kind: "summary",
      pricingFingerprint,
      startMs: timestamp,
      endMs: timestamp,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    },
  };
  const report = () =>
    executeUsageCostWorker(
      input,
      { consumeInput() {}, notify() {}, request: vi.fn() },
      { runNativeSection: async (operation) => operation(), throwIfCancelled() {} },
      async (_database, read) => read(),
    );
  const pending = report();
  try {
    await withinTest(
      awaitGateBeforeSettlement(projecting.promise, pending, "Report did not reach projection"),
      signal,
    );
    const insideReportSnapshot = db.isTransaction;
    write(db, 7);
    resume.resolve();
    expect(insideReportSnapshot).toBe(false);
    expect(await pending).toMatchObject({
      kind: "summary",
      summary: { totals: { totalTokens: 3, totalCost: 0.3 } },
    });
    expect(await report()).toMatchObject({
      kind: "summary",
      summary: { totals: { totalTokens: 7, totalCost: 0.7 } },
    });
  } finally {
    resume.resolve();
    await pending.catch(() => {});
    db.close();
  }
});
