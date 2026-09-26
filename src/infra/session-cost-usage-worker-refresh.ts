import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ModelCostConfig } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import {
  resolveUsageCostTranscriptFile,
  type UsageCostCollectionAccess,
} from "./session-cost-usage-collection.js";
import {
  applyCostBreakdown,
  applyCostTotal,
  applyUsageTotals,
  parseUsageCostTranscriptRecord,
  needsUsageCostEstimate,
  applyUsageCostEstimate,
} from "./session-cost-usage-pricing.js";
import {
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostJsonlCheckpoint,
  type UsageCostSqliteCheckpoint,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
  type SessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  ParsedTranscriptEntry,
  UsageCostTranscriptFile,
} from "./session-cost-usage.types.js";

const USAGE_COST_FILE_ANCHOR_BYTES = 4096;

function hashUsageCostCheckpoint(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function readJsonlAnchorHash(filePath: string, offset: number): Promise<string | undefined> {
  const start = Math.max(0, offset - USAGE_COST_FILE_ANCHOR_BYTES);
  const length = offset - start;
  if (length === 0) {
    return hashUsageCostCheckpoint("");
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? hashUsageCostCheckpoint(buffer) : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJsonlRecord(line: Buffer): Record<string, unknown> | undefined {
  const text = line.toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function scanJsonlRange(params: {
  filePath: string;
  startOffset: number;
  endOffset: number;
  onRecord: (record: Record<string, unknown>) => void | Promise<void>;
}): Promise<number> {
  if (params.endOffset <= params.startOffset) {
    return params.startOffset;
  }
  const stream = fs.createReadStream(params.filePath, {
    start: params.startOffset,
    end: params.endOffset - 1,
  });
  // Retain fragments until a line is complete; growing a contiguous carry buffer
  // would repeatedly copy and rescan large transcript records.
  const lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let chunkStart = params.startOffset;
  let processedOffset = params.startOffset;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let lineStart = 0;
      for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, lineStart)) {
        const fragment = bytes.subarray(lineStart, newline);
        let line = fragment;
        if (lineChunks.length > 0) {
          lineChunks.push(fragment);
          line = Buffer.concat(lineChunks, lineBytes + fragment.length);
          lineChunks.length = 0;
          lineBytes = 0;
        }
        const record = parseJsonlRecord(line);
        if (record) {
          const pending = params.onRecord(record);
          if (pending) {
            await pending;
          }
        }
        processedOffset = chunkStart + newline + 1;
        lineStart = newline + 1;
      }
      if (lineStart < bytes.length) {
        const fragment = bytes.subarray(lineStart);
        lineChunks.push(fragment);
        lineBytes += fragment.length;
      }
      chunkStart += bytes.length;
    }
    const firstChunk = lineChunks[0];
    if (firstChunk) {
      const record = parseJsonlRecord(
        lineChunks.length === 1 ? firstChunk : Buffer.concat(lineChunks, lineBytes),
      );
      if (record) {
        const pending = params.onRecord(record);
        if (pending) {
          await pending;
        }
        processedOffset = params.endOffset;
      }
    }
    return processedOffset;
  } finally {
    stream.destroy();
  }
}

function appendParsedEntryToRollup(
  rollup: SessionUsageRollupData,
  entry: ParsedTranscriptEntry,
): { countedRecord: boolean; parsedRecord: boolean } {
  let usageTotals: CostUsageTotals | undefined;
  if (entry.usage) {
    usageTotals = emptyTotals();
    applyUsageTotals(usageTotals, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(usageTotals, entry.costBreakdown);
    } else {
      applyCostTotal(usageTotals, entry.costTotal, entry.provider, entry.model);
    }
  }
  const timestamp = entry.timestamp?.getTime();
  appendSessionUsageRollupContribution(rollup, {
    timestamp,
    role: entry.role,
    durationMs: entry.durationMs,
    provider: entry.provider,
    model: entry.model,
    stopReason: entry.stopReason,
    toolNames: entry.toolNames,
    toolResultCounts: entry.toolResultCounts,
    usageTotals,
  });
  return { parsedRecord: Boolean(entry.usage), countedRecord: Boolean(entry.usage && timestamp) };
}

type RollupScanInput = {
  file: UsageCostTranscriptFile;
  previous?: UsageCostRollupEntry;
  pricingFingerprint: string;
  resolveCosts: (
    pairs: Array<{ provider?: string; model?: string }>,
  ) => Promise<Array<ModelCostConfig | undefined>>;
  readRows: (
    marker: SqliteSessionFileMarker,
    afterSeq: number,
    throughSeq: number,
  ) => Promise<Array<{ seq: number; event: unknown }>>;
  access: UsageCostCollectionAccess;
};

function createUsageRollupScan(params: RollupScanInput & { appendOnly: boolean }) {
  const previous = params.appendOnly ? params.previous : undefined;
  // This task exclusively owns the decoded body; publication retains its original envelope for CAS.
  const rollup = previous?.rollup ?? createSessionUsageRollupData();
  let countedRecords = 0;
  let parsedRecords = 0;
  return {
    async addRecords(records: Iterable<Record<string, unknown>>): Promise<void> {
      let batch: ParsedTranscriptEntry[] = [];
      const flush = async () => {
        const estimated = batch.filter(needsUsageCostEstimate);
        const costs = await params.resolveCosts(
          estimated.map(({ provider, model }) => ({ provider, model })),
        );
        for (let i = 0; i < estimated.length; i++) {
          applyUsageCostEstimate(estimated[i]!, () => costs[i]);
        }
        for (const entry of batch) {
          const counted = appendParsedEntryToRollup(rollup, entry);
          countedRecords += counted.countedRecord ? 1 : 0;
          parsedRecords += counted.parsedRecord ? 1 : 0;
        }
        batch = [];
      };
      for (const record of records) {
        const entry = parseUsageCostTranscriptRecord(record);
        if (entry) {
          batch.push(entry);
        }
        if (batch.length === 128) {
          await flush();
        }
      }
      if (batch.length > 0) {
        await flush();
      }
    },
    finish(checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint): UsageCostRollupEntry {
      return {
        version: USAGE_COST_ROLLUP_VERSION,
        pricingFingerprint: params.pricingFingerprint,
        checkpoint,
        scannedAt: Date.now(),
        parsedRecords: (previous?.parsedRecords ?? 0) + parsedRecords,
        countedRecords: (previous?.countedRecords ?? 0) + countedRecords,
        rollup,
      };
    },
  };
}

async function scanJsonlUsageRollup(params: RollupScanInput): Promise<UsageCostRollupEntry> {
  const previousCheckpoint =
    params.previous?.checkpoint.kind === "jsonl" ? params.previous.checkpoint : undefined;
  const identityMatches =
    previousCheckpoint &&
    previousCheckpoint.device === params.file.device &&
    previousCheckpoint.inode === params.file.inode &&
    previousCheckpoint.parsedOffset <= params.file.size &&
    params.file.size > previousCheckpoint.observedSize;
  const previousAnchor = identityMatches
    ? await readJsonlAnchorHash(params.file.filePath, previousCheckpoint.parsedOffset)
    : undefined;
  const appendOnly = Boolean(
    identityMatches && previousAnchor === previousCheckpoint?.anchorHash && params.previous,
  );
  const startOffset = appendOnly ? (previousCheckpoint?.parsedOffset ?? 0) : 0;
  const scan = createUsageRollupScan({ ...params, appendOnly });
  let pendingRecords: Record<string, unknown>[] = [];
  const processedOffset = await scanJsonlRange({
    filePath: params.file.filePath,
    startOffset,
    endOffset: params.file.size,
    onRecord: (record) => {
      pendingRecords.push(record);
      if (pendingRecords.length === 128) {
        const batch = pendingRecords;
        pendingRecords = [];
        return scan.addRecords(batch);
      }
      return undefined;
    },
  });
  await scan.addRecords(pendingRecords);
  const postStats = await fs.promises.stat(params.file.filePath);
  if (
    postStats.dev !== params.file.device ||
    postStats.ino !== params.file.inode ||
    postStats.size < params.file.size
  ) {
    throw new Error(`transcript changed identity while scanning: ${params.file.filePath}`);
  }
  const anchorHash = await readJsonlAnchorHash(params.file.filePath, processedOffset);
  if (!anchorHash) {
    throw new Error(`transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  return scan.finish({
    kind: "jsonl",
    parsedOffset: processedOffset,
    observedSize: params.file.size,
    observedMtimeMs: params.file.mtimeMs,
    device: params.file.device ?? 0,
    inode: params.file.inode ?? 0,
    anchorHash,
  });
}

function selectIncrementalSqliteRecords(
  records: Record<string, unknown>[],
  previousLeafId: string | undefined,
): { records: Record<string, unknown>[]; visibleLeafId?: string } | undefined {
  let visibleLeafId = previousLeafId;
  const visible: Record<string, unknown>[] = [];
  for (const record of records) {
    if (isSessionTranscriptLeafControl(record) || record.appendMode === "side") {
      return undefined;
    }
    if (!isCanonicalSessionTranscriptEntry(record)) {
      continue;
    }
    const id = typeof record.id === "string" && record.id ? record.id : undefined;
    if (!id) {
      return undefined;
    }
    if (Object.hasOwn(record, "parentId")) {
      const parentId = record.parentId === null ? undefined : record.parentId;
      if (parentId !== visibleLeafId) {
        return undefined;
      }
    }
    visible.push(record);
    visibleLeafId = id;
  }
  return { records: visible, ...(visibleLeafId ? { visibleLeafId } : {}) };
}

function sqliteCheckpointAnchorHash(event: unknown): string {
  return hashUsageCostCheckpoint(JSON.stringify(event));
}

async function scanSqliteUsageRollup(params: RollupScanInput): Promise<UsageCostRollupEntry> {
  const scope = parseSqliteSessionFileMarker(params.file.filePath);
  if (!scope) {
    throw new Error(`invalid SQLite transcript marker: ${params.file.filePath}`);
  }
  const maxSeq = params.file.maxSeq ?? 0;
  const eventCount = params.file.eventCount ?? 0;
  const readAtSeq = async (seq: number) => (await params.readRows(scope, seq - 1, seq))[0];
  const snapshotLastRow = maxSeq > 0 ? await readAtSeq(maxSeq) : undefined;
  if (maxSeq > 0 && !snapshotLastRow) {
    throw new Error(`SQLite transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  const snapshotAnchorHash = snapshotLastRow
    ? sqliteCheckpointAnchorHash(snapshotLastRow.event)
    : hashUsageCostCheckpoint("");
  const previousCheckpoint =
    params.previous?.checkpoint.kind === "sqlite" ? params.previous.checkpoint : undefined;
  const previousAnchor = previousCheckpoint?.maxSeq
    ? await readAtSeq(previousCheckpoint.maxSeq)
    : undefined;
  const anchorMatches =
    previousCheckpoint?.maxSeq === 0 ||
    (previousAnchor &&
      sqliteCheckpointAnchorHash(previousAnchor.event) === previousCheckpoint?.anchorHash);
  const appendCandidate = Boolean(
    params.previous &&
    previousCheckpoint &&
    previousCheckpoint.maxSeq < maxSeq &&
    previousCheckpoint.eventCount < eventCount &&
    anchorMatches,
  );
  const afterSeq = appendCandidate ? (previousCheckpoint?.maxSeq ?? 0) : 0;
  // Branch selection retains only navigation facts, never transcript bodies.
  const readNavigation = async (startSeq: number) => {
    let after = startSeq;
    const records: Array<Record<string, unknown> & { seq: number }> = [];
    while (after < maxSeq) {
      const page = await params.readRows(scope, after, maxSeq);
      if (page.length === 0) {
        break;
      }
      for (const { seq, event } of page) {
        const record: Record<string, unknown> & { seq: number } = { seq };
        if (isRecord(event)) {
          for (const key of [
            "type",
            "id",
            "parentId",
            "targetId",
            "appendParentId",
            "appendMode",
          ]) {
            if (Object.hasOwn(event, key)) {
              record[key] = event[key];
            }
          }
        }
        records.push(record);
      }
      after = page.at(-1)!.seq;
    }
    return records;
  };
  let navigation = await readNavigation(afterSeq);
  const incremental = appendCandidate
    ? selectIncrementalSqliteRecords(navigation, previousCheckpoint?.visibleLeafId)
    : undefined;
  const appendOnly = Boolean(incremental && params.previous);
  if (!appendOnly && afterSeq > 0) {
    navigation = await readNavigation(0);
  }
  const selected = appendOnly
    ? navigation.filter(isCanonicalSessionTranscriptEntry)
    : selectVisibleTranscriptEvents(navigation);
  const scan = createUsageRollupScan({ ...params, appendOnly });
  let page = new Map<number, unknown>();
  let pending: Record<string, unknown>[] = [];
  for (const record of selected) {
    if (!page.has(record.seq)) {
      await scan.addRecords(pending);
      pending = [];
      page.clear();
      page = new Map(
        (await params.readRows(scope, record.seq - 1, maxSeq)).map((row) => [row.seq, row.event]),
      );
      if (!page.has(record.seq)) {
        throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
      }
    }
    const event = page.get(record.seq);
    if (isRecord(event)) {
      pending.push(event);
    }
  }
  await scan.addRecords(pending);
  const postFile = await resolveUsageCostTranscriptFile(params.file.filePath, params.access);
  if (!postFile || (postFile.maxSeq ?? 0) < maxSeq || (postFile.eventCount ?? 0) < eventCount) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const currentLastRow = maxSeq > 0 ? await readAtSeq(maxSeq) : undefined;
  if (
    (maxSeq > 0 && !currentLastRow) ||
    (currentLastRow && sqliteCheckpointAnchorHash(currentLastRow.event) !== snapshotAnchorHash)
  ) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const visibleLeafId = appendOnly
    ? incremental?.visibleLeafId
    : (scanSessionTranscriptTree(navigation).leafId ?? undefined);
  return scan.finish({
    kind: "sqlite",
    maxSeq,
    eventCount,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    anchorHash: snapshotAnchorHash,
    ...(visibleLeafId ? { visibleLeafId } : {}),
  });
}

export function scanUsageCostRollupInWorker(
  params: RollupScanInput,
): Promise<UsageCostRollupEntry> {
  return params.file.kind === "sqlite"
    ? scanSqliteUsageRollup(params)
    : scanJsonlUsageRollup(params);
}
