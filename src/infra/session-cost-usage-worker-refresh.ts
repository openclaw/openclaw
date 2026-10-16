import fs from "node:fs";
import type { ModelCostConfig } from "@openclaw/llm-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
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
import { sha256Base64Url } from "./crypto-digest.js";
import { parseUsageCostTranscriptRecord } from "./session-cost-usage-pricing.js";
import type { UsageCostRollupEntry } from "./session-cost-usage-rollup-codec.js";
import { createUsageRollupScan } from "./session-cost-usage-rollup-scan.js";
import type { ParsedTranscriptEntry, UsageCostTranscriptFile } from "./session-cost-usage.types.js";

/** Reuse resolved model prices across the bounded pages of one worker operation. */
export function createUsageCostWorkerPriceResolver(
  resolveMissing: (
    pairs: Array<{ provider?: string; model?: string }>,
  ) => Promise<Array<ModelCostConfig | undefined>>,
) {
  const prices = new Map<string, ModelCostConfig | undefined>();
  return async (pairs: Array<{ provider?: string; model?: string }>) => {
    const missing = new Map(
      pairs
        .filter((pair) => !prices.has(JSON.stringify(pair)))
        .map((pair) => [JSON.stringify(pair), pair]),
    );
    if (missing.size > 0) {
      const keys = [...missing.keys()];
      const costs = await resolveMissing([...missing.values()]);
      keys.forEach((key, index) => prices.set(key, costs[index]));
    }
    return pairs.map((pair) => prices.get(JSON.stringify(pair)));
  };
}

const USAGE_COST_FILE_ANCHOR_BYTES = 4096;

async function readJsonlAnchorHash(filePath: string, offset: number): Promise<string | undefined> {
  const start = Math.max(0, offset - USAGE_COST_FILE_ANCHOR_BYTES);
  const length = offset - start;
  if (length === 0) {
    return sha256Base64Url("");
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? sha256Base64Url(buffer) : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJsonlRecord(line: Buffer): Record<string, unknown> | undefined {
  return safeParseJsonRecord(line.toString("utf8").trim());
}

async function scanJsonlRange(params: {
  filePath: string;
  startOffset: number;
  endOffset: number;
  checkProgress?: () => void;
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
      params.checkProgress?.();
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

type RollupScanInput = {
  file: UsageCostTranscriptFile;
  previous?: UsageCostRollupEntry;
  pricingFingerprint: string;
  resolveCosts: (
    pairs: Array<{ provider?: string; model?: string }>,
  ) => Promise<Array<ModelCostConfig | undefined>>;
  readGeneration: (marker: SqliteSessionFileMarker) => Promise<string | null | undefined>;
  readRows: (
    marker: SqliteSessionFileMarker,
    afterSeq: number,
    throughSeq: number,
  ) => Promise<Array<{ seq: number; event: unknown }>>;
  checkProgress?: () => void;
};

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
    checkProgress: params.checkProgress,
    onRecord: (record) => {
      pendingRecords.push(record);
      if (pendingRecords.length === 128) {
        const batch = pendingRecords;
        pendingRecords = [];
        return scan.addEntries(
          batch.flatMap((item) => {
            const entry = parseUsageCostTranscriptRecord(item);
            return entry ? [entry] : [];
          }),
        );
      }
      return undefined;
    },
  });
  await scan.addEntries(
    pendingRecords.flatMap((record) => {
      const entry = parseUsageCostTranscriptRecord(record);
      return entry ? [entry] : [];
    }),
  );
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
): { visibleLeafId?: string } | undefined {
  let visibleLeafId = previousLeafId;
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
    visibleLeafId = id;
  }
  return { visibleLeafId };
}

function sqliteCheckpointAnchorHash(event: unknown): string {
  return sha256Base64Url(JSON.stringify(event));
}

async function scanSqliteUsageRollup(params: RollupScanInput): Promise<UsageCostRollupEntry> {
  const scope = parseSqliteSessionFileMarker(params.file.filePath);
  if (!scope) {
    throw new Error(`invalid SQLite transcript marker: ${params.file.filePath}`);
  }
  const maxSeq = params.file.maxSeq ?? 0;
  const eventCount = params.file.eventCount ?? 0;
  // The transcript owner changes this existing watermark on rewrites. Read it
  // once, rather than rereading old payloads to guess whether the prefix survived.
  const generation = await params.readGeneration(scope);
  const previousCheckpoint =
    params.previous?.checkpoint.kind === "sqlite" ? params.previous.checkpoint : undefined;
  const appendCandidate = Boolean(
    params.previous &&
    previousCheckpoint &&
    generation !== undefined &&
    previousCheckpoint.generation === generation &&
    previousCheckpoint.maxSeq < maxSeq &&
    previousCheckpoint.eventCount < eventCount,
  );
  const afterSeq = appendCandidate ? (previousCheckpoint?.maxSeq ?? 0) : 0;
  type UsageRecord = Record<string, unknown> & {
    seq: number;
    usageEntry: ParsedTranscriptEntry | null;
  };
  let anchorHash = sha256Base64Url("");
  // Keep navigation and small usage contributions, never retained message bodies.
  // Each payload page is parsed once, including during a branch rebuild.
  const readRange = async (startSeq: number, endSeq: number) => {
    let after = startSeq;
    const records: UsageRecord[] = [];
    while (after < endSeq) {
      params.checkProgress?.();
      const page = await params.readRows(scope, after, endSeq);
      params.checkProgress?.();
      if (page.length === 0) {
        throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
      }
      for (const { seq, event } of page) {
        const record: UsageRecord = {
          seq,
          usageEntry: isRecord(event) ? parseUsageCostTranscriptRecord(event) : null,
        };
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
        if (seq === maxSeq) {
          anchorHash = sqliteCheckpointAnchorHash(event);
        }
        records.push(record);
      }
      after = page.at(-1)!.seq;
    }
    return records;
  };
  let records = await readRange(afterSeq, maxSeq);
  const incremental = appendCandidate
    ? selectIncrementalSqliteRecords(records, previousCheckpoint?.visibleLeafId)
    : undefined;
  const appendOnly = Boolean(incremental && params.previous);
  if (!appendOnly && afterSeq > 0) {
    // A rewind or side branch needs the prefix, but the suffix is already decoded.
    records = [...(await readRange(0, afterSeq)), ...records];
  }
  const selected = appendOnly
    ? records.filter(isCanonicalSessionTranscriptEntry)
    : selectVisibleTranscriptEvents(records);
  const scan = createUsageRollupScan({ ...params, appendOnly });
  await scan.addEntries(
    selected.flatMap((record) => (record.usageEntry ? [record.usageEntry] : [])),
  );
  const visibleLeafId = appendOnly
    ? incremental?.visibleLeafId
    : (scanSessionTranscriptTree(records).leafId ?? undefined);
  // A rewrite arriving during this background scan is handled by its publication;
  // the next refresh observes the new generation and rebuilds this derived cache.
  return scan.finish({
    kind: "sqlite",
    maxSeq,
    eventCount,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    anchorHash,
    ...(generation !== undefined ? { generation } : {}),
    ...(visibleLeafId ? { visibleLeafId } : {}),
  });
}

export async function scanUsageCostRollupInWorker(
  params: RollupScanInput,
): Promise<UsageCostRollupEntry> {
  params.checkProgress?.();
  return params.file.kind === "sqlite"
    ? scanSqliteUsageRollup(params)
    : scanJsonlUsageRollup(params);
}
