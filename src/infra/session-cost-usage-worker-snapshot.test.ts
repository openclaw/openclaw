import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  createUsageCheckpoint,
  createUsageRollupEntry,
  createUsageTranscriptEntry,
} from "./session-cost-usage-fixtures.test-support.js";
import { partitionUsageCostRollup } from "./session-cost-usage-partitions.js";
import {
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_SCOPE,
  type UsageCostRollupEntry,
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
  withRead: vi.fn(),
  inventory: vi.fn<() => Promise<UsageCostTranscriptFile[]>>(),
  selectedFiles: vi.fn<() => Promise<UsageCostTranscriptFile[]>>(),
}));

// mock-isolation: Use only the borrowed native connection, without opening real agent stores.
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: fixture.withRead,
}));
// mock-isolation: Pause transcript discovery without loading the worker's retained refresh state.
vi.mock("./session-cost-usage-refresh-inputs.worker.js", () => ({
  createUsageCostCollectionAccess: () => ({ inventory: fixture.inventory }),
  usageRefreshInputs: vi.fn(),
}));
// mock-isolation: Supply captured aliases without opening a second native store in this worker test.
vi.mock("./session-cost-usage-collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cost-usage-collection.js")>()),
  resolveUsageCostTranscriptFiles: fixture.selectedFiles,
}));

afterEach(() => vi.resetAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const timestamp = Date.UTC(2026, 8, 18);
const pricingFingerprint = "synthetic-pricing";
function cacheDatabase() {
  const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
  db.exec(`CREATE TABLE cache_entries (
    scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT, blob BLOB,
    expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key)
  )`);
  return db;
}
function reportFile(filePath: string, inode: number): UsageCostTranscriptFile {
  return {
    filePath,
    sourcePath: filePath,
    kind: "jsonl",
    size: 100,
    mtimeMs: timestamp,
    device: 1,
    inode,
  };
}
function reportEntry(file: UsageCostTranscriptFile, tokens: number): UsageCostRollupEntry {
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
  return createUsageRollupEntry(rollup, {
    pricingFingerprint,
    checkpoint: {
      ...createUsageCheckpoint(file.size, file.mtimeMs, file.inode ?? 0),
      anchorHash: "synthetic-anchor",
    },
    scannedAt: timestamp,
    parsedRecords: 1,
    countedRecords: 1,
  });
}

function borrowDatabase(db: DatabaseSync) {
  fixture.withRead.mockImplementation((read: (opened: { db: DatabaseSync }) => unknown) => ({
    found: true,
    value: read({ db }),
  }));
}

function execute(
  operation: UsageCostWorkerInput["operation"],
  request: Parameters<typeof executeUsageCostWorker>[1]["request"] = vi.fn(),
) {
  return executeUsageCostWorker(
    {
      kind: "usage-cost",
      location: { agentId: "main", databasePath: ":memory:", storePath: ":memory:", env: {} },
      databases: [{ agentId: "main", path: ":memory:" }],
      stores: [],
      archiveStorePaths: [],
      operation,
    },
    { consumeInput() {}, notify() {}, request },
    { runNativeSection: async (run) => run(), throwIfCancelled() {} },
    async (_database, read) => read(),
  );
}

it.for([
  { selected: false, scanMs: 11_000 },
  { selected: true, scanMs: 11_000 },
  { selected: true, scanMs: 0 },
])(
  "batches whole transcripts and retains pending selectors ($selected, $scanMs ms)",
  async ({ selected, scanMs }) => {
    const root = tempDirs.make("usage-batch-quantum-");
    const entry = createUsageTranscriptEntry(7, { cost: 1 });
    Object.assign(entry.message.usage, { output: 3, totalTokens: 10 });
    const text = JSON.stringify({ ...entry, id: "usage", parentId: null }) + "\n";
    const files: UsageCostTranscriptFile[] = ["a", "b"].map((name) => {
      const filePath = path.join(root, `${name}.jsonl`);
      fs.writeFileSync(filePath, text);
      const stats = fs.statSync(filePath);
      return {
        kind: "jsonl",
        filePath,
        sourcePath: filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      };
    });
    fixture.inventory.mockResolvedValue(files);
    const requested = [
      files[0]!,
      { ...files[1]!, sourcePath: `${files[1]!.sourcePath}.alias` },
      files[1]!,
    ];
    fixture.selectedFiles.mockResolvedValue(requested);
    const db = cacheDatabase();
    borrowDatabase(db);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const written: string[] = [];
    const batches: number[] = [];
    try {
      const result = await execute(
        {
          kind: "refresh",
          pricingFingerprint,
          maxFiles: 50,
          sessionFiles: selected ? requested.map((file) => file.sourcePath) : undefined,
        },
        async (value) => {
          let output: unknown;
          if (isRecord(value) && value.kind === "write" && Array.isArray(value.input)) {
            batches.push(value.input.length);
            for (const row of value.input) {
              if (isRecord(row) && typeof row.key === "string") {
                written.push(row.key);
              }
            }
            output = true;
          } else if (isRecord(value) && value.kind === "refresh-session") {
            now += scanMs;
          } else if (isRecord(value) && value.kind === "pricing" && Array.isArray(value.input)) {
            output = value.input.map(() => undefined);
          }
          return { input: output, consumed() {} };
        },
      );
      expect(batches).toEqual(scanMs ? [1] : [2]);
      expect(written).toEqual((scanMs ? files.slice(0, 1) : files).map((file) => file.filePath));
      expect(result).toEqual({
        kind: "refresh",
        changed: true,
        ...(scanMs
          ? {
              remainingFiles: (selected ? requested.slice(1) : files.slice(1)).map((file) => ({
                sessionFile: file.sourcePath,
                rollupId: file.filePath,
              })),
            }
          : {}),
      });
    } finally {
      clock.mockRestore();
      db.close();
    }
  },
);

it("spends the shared decoded budget on complete reports after preparing the snapshot", async () => {
  const entries = [17, 23].map((tokens) => {
    const file = reportFile(`/synthetic/report-${tokens}.jsonl`, tokens);
    const entry = reportEntry(file, tokens);
    // Untimestamped tool counts remain in the body, not its dated partitions.
    appendSessionUsageRollupContribution(entry.rollup, {
      toolNames: Array.from({ length: 32 }, (_, index) => `synthetic-unattributed-tool-${index}`),
      toolResultCounts: { total: 0, errors: 0 },
    });
    const encoded = partitionUsageCostRollup(entry);
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
    rollup: { buckets: { [String(timestamp)]: { totals: { totalTokens: 17, totalCost: 1.7 } } } },
  });
  expect(await read(second)).toBeNull();
});

it("ends the cache snapshot before projection awaits and preserves a concurrent write", async ({
  signal,
}) => {
  const db = cacheDatabase();
  const file = reportFile("/synthetic/report.jsonl", 2);
  const write = (connection: DatabaseSync, tokens: number) => {
    const encoded = encodeUsageCostRollup(reportEntry(file, tokens));
    connection
      .prepare(`INSERT INTO cache_entries (scope, key, value_json, blob, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (scope, key) DO UPDATE SET
          value_json = excluded.value_json, blob = excluded.blob, updated_at = excluded.updated_at`)
      .run(USAGE_COST_ROLLUP_SCOPE, file.filePath, encoded.valueJson, encoded.blob, timestamp);
  };
  write(db, 3);
  // Borrow one native connection so an independent job can use it while projection waits.
  borrowDatabase(db);
  const projecting = createDeferredCore();
  const resume = createDeferredCore();
  fixture.inventory.mockImplementationOnce(async () => {
    projecting.resolve();
    await resume.promise;
    return [file];
  });
  fixture.inventory.mockResolvedValue([file]);
  const report = () =>
    execute({
      kind: "summary",
      pricingFingerprint,
      startMs: timestamp,
      endMs: timestamp,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
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
