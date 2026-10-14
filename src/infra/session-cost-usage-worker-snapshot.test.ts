import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  withRead: vi.fn(),
  inventory: vi.fn<() => Promise<UsageCostTranscriptFile[]>>(),
  selectedFiles: vi.fn<() => Promise<UsageCostTranscriptFile[]>>(),
}));

// mock-isolation: Use only the borrowed native connection, without opening real agent stores.
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  openOpenClawAgentDatabaseReadOnly: fixture.open,
  withOpenClawAgentDatabaseReadOnly: fixture.withRead,
}));
// mock-isolation: Pause transcript discovery without loading the worker's retained refresh state.
vi.mock("./session-cost-usage-refresh-inputs.worker.js", () => ({
  createUsageCostCollectionAccess: () => ({
    inventory: fixture.inventory,
  }),
  usageRefreshInputs: vi.fn(),
}));
// mock-isolation: Supply captured aliases without opening a second native store in this worker test.
vi.mock("./session-cost-usage-collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cost-usage-collection.js")>()),
  resolveUsageCostTranscriptFiles: fixture.selectedFiles,
}));

afterEach(() => vi.resetAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.for([false, true])(
  "yields whole transcripts and retains every pending selector (selected: %s)",
  async (selected) => {
    const root = tempDirs.make("usage-batch-quantum-");
    const text =
      JSON.stringify({
        type: "message",
        id: "usage",
        parentId: null,
        timestamp: "2026-09-18T00:00:00Z",
        message: {
          role: "assistant",
          usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
        },
      }) + "\n";
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
    const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
    db.exec(`CREATE TABLE cache_entries (
    scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT, blob BLOB,
    expires_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key)
  )`);
    fixture.withRead.mockImplementation((read: (opened: { db: DatabaseSync }) => unknown) => ({
      found: true,
      value: read({ db }),
    }));
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const written: string[] = [];
    try {
      const result = await executeUsageCostWorker(
        {
          kind: "usage-cost",
          location: { agentId: "main", databasePath: ":memory:", storePath: ":memory:", env: {} },
          databases: [{ agentId: "main", path: ":memory:" }],
          stores: [],
          archiveStorePaths: [],
          operation: {
            kind: "refresh",
            pricingFingerprint: "synthetic-pricing",
            maxFiles: 50,
            sessionFiles: selected ? requested.map((file) => file.sourcePath) : undefined,
          },
        },
        {
          consumeInput() {},
          notify() {},
          async request(value) {
            let output: unknown;
            if (
              isRecord(value) &&
              value.kind === "write" &&
              isRecord(value.input) &&
              typeof value.input.key === "string"
            ) {
              written.push(value.input.key);
              now += 11_000;
              output = true;
            } else if (isRecord(value) && value.kind === "pricing" && Array.isArray(value.input)) {
              output = value.input.map(() => undefined);
            }
            return { input: { ok: true, value: output }, consumed() {} };
          },
        },
        { runNativeSection: async (operation) => operation(), throwIfCancelled() {} },
        async (_database, read) => read(),
      );
      clock.mockRestore();
      expect(written).toEqual([files[0]!.filePath]);
      expect(result).toEqual({
        kind: "refresh",
        changed: true,
        remainingFiles: (selected ? requested.slice(1) : files.slice(1)).map((file) => ({
          sessionFile: file.sourcePath,
          rollupId: file.filePath,
        })),
      });
    } finally {
      clock.mockRestore();
      db.close();
    }
  },
);

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
    stores: [],
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
