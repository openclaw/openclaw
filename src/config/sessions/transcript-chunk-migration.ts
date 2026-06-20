import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import type { SessionStoreAdapter, SessionTranscriptChunk } from "./storage-adapter.js";

export type TranscriptJsonlMalformedLine = {
  lineNumber: number;
  reason: string;
  preview: string;
};

export type TranscriptJsonlMigrationPlan = {
  transcriptPath: string;
  storePath: string;
  sessionKey: string;
  transcriptSha256: string;
  totalLines: number;
  validLines: number;
  totalBytes: number;
  chunkCount: number;
  malformedLines: TranscriptJsonlMalformedLine[];
};

export type TranscriptJsonlMigrationCheckpoint = {
  transcriptPath: string;
  storePath: string;
  sessionKey: string;
  transcriptSha256: string;
  nextChunkSeq: number;
  chunksWritten: number;
  completed: boolean;
};

export type TranscriptJsonlMigrationMode = "dry-run" | "apply";

export type TranscriptJsonlVerificationIssueCode =
  | "total_count_mismatch"
  | "chunk_count_mismatch"
  | "chunk_missing"
  | "chunk_hash_mismatch"
  | "chunk_bytes_mismatch"
  | "chunk_transcript_path_mismatch"
  | "chunk_line_window_mismatch"
  | "chunk_line_count_mismatch"
  | "pagination_stalled";

export type TranscriptJsonlVerificationIssue = {
  code: TranscriptJsonlVerificationIssueCode;
  message: string;
  chunkSeq?: number;
  expected?: unknown;
  observed?: unknown;
};

export type TranscriptJsonlMigrationVerification = {
  requested: boolean;
  ok: boolean;
  chunksExpected: number;
  chunksRead: number;
  totalCount: number;
  bytesExpected: number;
  bytesRead: number;
  issues: TranscriptJsonlVerificationIssue[];
};

export type TranscriptJsonlMigrationResult = {
  mode: TranscriptJsonlMigrationMode;
  applied: boolean;
  verified: boolean;
  verification: TranscriptJsonlMigrationVerification;
  plan: TranscriptJsonlMigrationPlan;
  checkpoint: TranscriptJsonlMigrationCheckpoint;
};

export type TranscriptJsonlMigrationOptions = {
  destinationAdapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
  transcriptPath: string;
  mode?: TranscriptJsonlMigrationMode;
  batchSize: number;
  maxLinesPerChunk?: number;
  maxBytesPerChunk?: number;
  checkpoint?: TranscriptJsonlMigrationCheckpoint;
  skipMalformed?: boolean;
  agentId?: string;
  verifyAfterWrite?: boolean;
  onCheckpoint?: (checkpoint: TranscriptJsonlMigrationCheckpoint) => void | Promise<void>;
};

export class TranscriptJsonlMigrationError extends Error {
  readonly plan: TranscriptJsonlMigrationPlan;
  readonly checkpoint: TranscriptJsonlMigrationCheckpoint;

  constructor(
    message: string,
    params: { plan: TranscriptJsonlMigrationPlan; checkpoint: TranscriptJsonlMigrationCheckpoint },
  ) {
    super(message);
    this.name = "TranscriptJsonlMigrationError";
    this.plan = params.plan;
    this.checkpoint = params.checkpoint;
  }
}

type CollectedTranscriptChunks = {
  plan: TranscriptJsonlMigrationPlan;
  chunks: SessionTranscriptChunk[];
};

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string) {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) {
    throw new Error(`${label} must be finite`);
  }
  const normalized = Math.floor(candidate);
  if (normalized < 1) {
    throw new Error(`${label} must be at least 1`);
  }
  return normalized;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function linePreview(line: string): string {
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function buildCheckpoint(params: {
  plan: TranscriptJsonlMigrationPlan;
  nextChunkSeq: number;
  chunksWritten: number;
  completed: boolean;
}): TranscriptJsonlMigrationCheckpoint {
  return {
    transcriptPath: params.plan.transcriptPath,
    storePath: params.plan.storePath,
    sessionKey: params.plan.sessionKey,
    transcriptSha256: params.plan.transcriptSha256,
    nextChunkSeq: params.nextChunkSeq,
    chunksWritten: params.chunksWritten,
    completed: params.completed,
  };
}

function assertCheckpointMatches(
  checkpoint: TranscriptJsonlMigrationCheckpoint,
  plan: TranscriptJsonlMigrationPlan,
): void {
  if (
    checkpoint.transcriptPath !== plan.transcriptPath ||
    checkpoint.storePath !== plan.storePath ||
    checkpoint.sessionKey !== plan.sessionKey ||
    checkpoint.transcriptSha256 !== plan.transcriptSha256
  ) {
    throw new Error("Transcript migration checkpoint does not match current plan");
  }
}

function buildUnrequestedVerification(chunks: readonly SessionTranscriptChunk[]) {
  return {
    requested: false,
    ok: false,
    chunksExpected: chunks.length,
    chunksRead: 0,
    totalCount: 0,
    bytesExpected: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    bytesRead: 0,
    issues: [],
  } satisfies TranscriptJsonlMigrationVerification;
}

function flushChunk(params: {
  chunks: SessionTranscriptChunk[];
  transcriptPath: string;
  chunkSeq: number;
  startLine: number;
  endLine: number;
  lines: unknown[];
  rawLines: string[];
}): void {
  if (params.lines.length === 0) {
    return;
  }
  const rawText = `${params.rawLines.join("\n")}\n`;
  params.chunks.push({
    chunkSeq: params.chunkSeq,
    transcriptPath: params.transcriptPath,
    contentSha256: sha256(rawText),
    bytes: Buffer.byteLength(rawText, "utf8"),
    chunkJson: {
      version: 1,
      startLine: params.startLine,
      endLine: params.endLine,
      lines: structuredClone(params.lines) as unknown[],
    },
  });
}

function addVerificationIssue(
  issues: TranscriptJsonlVerificationIssue[],
  issue: TranscriptJsonlVerificationIssue,
): void {
  issues.push(issue);
}

async function readAllTranscriptChunksForVerification(params: {
  adapter: SessionStoreAdapter & Required<Pick<SessionStoreAdapter, "listTranscriptChunks">>;
  storePath: string;
  sessionKey: string;
  transcriptPath: string;
  pageSize: number;
}): Promise<{
  chunks: SessionTranscriptChunk[];
  totalCount: number;
  stalled: boolean;
}> {
  const chunks: SessionTranscriptChunk[] = [];
  let totalCount = 0;
  let offset = 0;
  let stalled = false;
  for (;;) {
    const result = await params.adapter.listTranscriptChunks(params.storePath, params.sessionKey, {
      limit: params.pageSize,
      offset,
      orderBy: "chunkSeq_asc",
      transcriptPath: params.transcriptPath,
    });
    totalCount = result.totalCount;
    chunks.push(...result.chunks);
    if (!result.hasMore) {
      break;
    }
    const nextOffset = result.nextOffset ?? offset + result.chunks.length;
    if (nextOffset <= offset || result.chunks.length === 0) {
      stalled = true;
      break;
    }
    offset = nextOffset;
  }
  return { chunks, totalCount, stalled };
}

async function verifyWrittenTranscriptChunks(params: {
  adapter: SessionStoreAdapter & Required<Pick<SessionStoreAdapter, "listTranscriptChunks">>;
  storePath: string;
  sessionKey: string;
  transcriptPath: string;
  expectedChunks: readonly SessionTranscriptChunk[];
  pageSize: number;
}): Promise<TranscriptJsonlMigrationVerification> {
  const read = await readAllTranscriptChunksForVerification({
    adapter: params.adapter,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    transcriptPath: params.transcriptPath,
    pageSize: params.pageSize,
  });
  const issues: TranscriptJsonlVerificationIssue[] = [];
  if (read.stalled) {
    addVerificationIssue(issues, {
      code: "pagination_stalled",
      message: "Transcript chunk verification pagination did not advance",
    });
  }
  if (read.totalCount !== params.expectedChunks.length) {
    addVerificationIssue(issues, {
      code: "total_count_mismatch",
      message: "Transcript chunk verification total count does not match migration plan",
      expected: params.expectedChunks.length,
      observed: read.totalCount,
    });
  }
  if (read.chunks.length !== params.expectedChunks.length) {
    addVerificationIssue(issues, {
      code: "chunk_count_mismatch",
      message: "Transcript chunk verification read count does not match migration plan",
      expected: params.expectedChunks.length,
      observed: read.chunks.length,
    });
  }
  const observedBySeq = new Map(read.chunks.map((chunk) => [chunk.chunkSeq, chunk]));
  for (const expected of params.expectedChunks) {
    const observed = observedBySeq.get(expected.chunkSeq);
    if (!observed) {
      addVerificationIssue(issues, {
        code: "chunk_missing",
        message: "Transcript chunk is missing from destination verification read",
        chunkSeq: expected.chunkSeq,
      });
      continue;
    }
    if (observed.contentSha256 !== expected.contentSha256) {
      addVerificationIssue(issues, {
        code: "chunk_hash_mismatch",
        message: "Transcript chunk content hash does not match source chunk",
        chunkSeq: expected.chunkSeq,
        expected: expected.contentSha256,
        observed: observed.contentSha256,
      });
    }
    if (observed.bytes !== expected.bytes) {
      addVerificationIssue(issues, {
        code: "chunk_bytes_mismatch",
        message: "Transcript chunk byte count does not match source chunk",
        chunkSeq: expected.chunkSeq,
        expected: expected.bytes,
        observed: observed.bytes,
      });
    }
    if (observed.transcriptPath !== expected.transcriptPath) {
      addVerificationIssue(issues, {
        code: "chunk_transcript_path_mismatch",
        message: "Transcript chunk transcript path does not match source chunk",
        chunkSeq: expected.chunkSeq,
        expected: expected.transcriptPath,
        observed: observed.transcriptPath,
      });
    }
    if (
      observed.chunkJson.version !== expected.chunkJson.version ||
      observed.chunkJson.startLine !== expected.chunkJson.startLine ||
      observed.chunkJson.endLine !== expected.chunkJson.endLine
    ) {
      addVerificationIssue(issues, {
        code: "chunk_line_window_mismatch",
        message: "Transcript chunk line window does not match source chunk",
        chunkSeq: expected.chunkSeq,
        expected: {
          version: expected.chunkJson.version,
          startLine: expected.chunkJson.startLine,
          endLine: expected.chunkJson.endLine,
        },
        observed: {
          version: observed.chunkJson.version,
          startLine: observed.chunkJson.startLine,
          endLine: observed.chunkJson.endLine,
        },
      });
    }
    if (observed.chunkJson.lines.length !== expected.chunkJson.lines.length) {
      addVerificationIssue(issues, {
        code: "chunk_line_count_mismatch",
        message: "Transcript chunk parsed line count does not match source chunk",
        chunkSeq: expected.chunkSeq,
        expected: expected.chunkJson.lines.length,
        observed: observed.chunkJson.lines.length,
      });
    }
  }

  return {
    requested: true,
    ok: issues.length === 0,
    chunksExpected: params.expectedChunks.length,
    chunksRead: read.chunks.length,
    totalCount: read.totalCount,
    bytesExpected: params.expectedChunks.reduce((total, chunk) => total + chunk.bytes, 0),
    bytesRead: read.chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    issues,
  };
}

export async function collectTranscriptJsonlChunks(params: {
  transcriptPath: string;
  storePath: string;
  sessionKey: string;
  maxLinesPerChunk?: number;
  maxBytesPerChunk?: number;
}): Promise<CollectedTranscriptChunks> {
  const maxLinesPerChunk = normalizePositiveInteger(
    params.maxLinesPerChunk,
    100,
    "maxLinesPerChunk",
  );
  const maxBytesPerChunk = normalizePositiveInteger(
    params.maxBytesPerChunk,
    256 * 1024,
    "maxBytesPerChunk",
  );
  const stream = fs.createReadStream(params.transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const transcriptHash = createHash("sha256");
  const chunks: SessionTranscriptChunk[] = [];
  const malformedLines: TranscriptJsonlMalformedLine[] = [];
  let totalLines = 0;
  let validLines = 0;
  let totalBytes = 0;
  let chunkSeq = 0;
  let chunkStartLine = 1;
  let chunkBytes = 0;
  let chunkLines: unknown[] = [];
  let rawChunkLines: string[] = [];

  for await (const line of rl) {
    totalLines += 1;
    const lineWithNewline = `${line}\n`;
    const lineBytes = Buffer.byteLength(lineWithNewline, "utf8");
    totalBytes += lineBytes;
    transcriptHash.update(lineWithNewline);
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      malformedLines.push({
        lineNumber: totalLines,
        reason: error instanceof Error ? error.message : "invalid JSON",
        preview: linePreview(line),
      });
      continue;
    }
    if (
      chunkLines.length > 0 &&
      (chunkLines.length >= maxLinesPerChunk || chunkBytes + lineBytes > maxBytesPerChunk)
    ) {
      flushChunk({
        chunks,
        transcriptPath: params.transcriptPath,
        chunkSeq,
        startLine: chunkStartLine,
        endLine: totalLines - 1,
        lines: chunkLines,
        rawLines: rawChunkLines,
      });
      chunkSeq += 1;
      chunkStartLine = totalLines;
      chunkBytes = 0;
      chunkLines = [];
      rawChunkLines = [];
    }
    validLines += 1;
    chunkLines.push(parsed);
    rawChunkLines.push(line);
    chunkBytes += lineBytes;
  }

  flushChunk({
    chunks,
    transcriptPath: params.transcriptPath,
    chunkSeq,
    startLine: chunkStartLine,
    endLine: totalLines,
    lines: chunkLines,
    rawLines: rawChunkLines,
  });

  const plan: TranscriptJsonlMigrationPlan = {
    transcriptPath: params.transcriptPath,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    transcriptSha256: transcriptHash.digest("hex"),
    totalLines,
    validLines,
    totalBytes,
    chunkCount: chunks.length,
    malformedLines,
  };
  return { plan, chunks };
}

export async function migrateTranscriptJsonlToAdapter(
  options: TranscriptJsonlMigrationOptions,
): Promise<TranscriptJsonlMigrationResult> {
  const mode = options.mode ?? "dry-run";
  const batchSize = normalizePositiveInteger(options.batchSize, 1, "batchSize");
  const { plan, chunks } = await collectTranscriptJsonlChunks({
    transcriptPath: options.transcriptPath,
    storePath: options.storePath,
    sessionKey: options.sessionKey,
    maxLinesPerChunk: options.maxLinesPerChunk,
    maxBytesPerChunk: options.maxBytesPerChunk,
  });
  if (options.checkpoint) {
    assertCheckpointMatches(options.checkpoint, plan);
  }
  if (plan.malformedLines.length > 0 && options.skipMalformed !== true) {
    throw new TranscriptJsonlMigrationError(
      `Transcript JSONL migration encountered ${plan.malformedLines.length} malformed line${plan.malformedLines.length === 1 ? "" : "s"}`,
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          nextChunkSeq: options.checkpoint?.nextChunkSeq ?? 0,
          chunksWritten: options.checkpoint?.chunksWritten ?? 0,
          completed: false,
        }),
      },
    );
  }
  if (mode === "dry-run") {
    const verification = buildUnrequestedVerification(chunks);
    return {
      mode,
      applied: false,
      verified: false,
      verification,
      plan,
      checkpoint: buildCheckpoint({
        plan,
        nextChunkSeq: options.checkpoint?.nextChunkSeq ?? 0,
        chunksWritten: options.checkpoint?.chunksWritten ?? 0,
        completed: false,
      }),
    };
  }
  if (!options.destinationAdapter.writeTranscriptChunks) {
    throw new TranscriptJsonlMigrationError(
      "Destination adapter does not support transcript chunk writes",
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          nextChunkSeq: options.checkpoint?.nextChunkSeq ?? 0,
          chunksWritten: options.checkpoint?.chunksWritten ?? 0,
          completed: false,
        }),
      },
    );
  }
  const shouldVerifyAfterWrite = options.verifyAfterWrite !== false;
  if (shouldVerifyAfterWrite && !options.destinationAdapter.listTranscriptChunks) {
    throw new TranscriptJsonlMigrationError(
      "Destination adapter does not support transcript chunk verification reads",
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          nextChunkSeq: options.checkpoint?.nextChunkSeq ?? 0,
          chunksWritten: options.checkpoint?.chunksWritten ?? 0,
          completed: false,
        }),
      },
    );
  }

  let chunksWritten = options.checkpoint?.chunksWritten ?? 0;
  for (let offset = options.checkpoint?.nextChunkSeq ?? 0; offset < chunks.length; ) {
    const batch = chunks.slice(offset, offset + batchSize);
    await options.destinationAdapter.writeTranscriptChunks(
      options.storePath,
      options.sessionKey,
      batch,
      options.agentId
        ? { agentId: options.agentId, skipMaintenance: true }
        : { skipMaintenance: true },
    );
    offset += batch.length;
    chunksWritten += batch.length;
    await options.onCheckpoint?.(
      buildCheckpoint({
        plan,
        nextChunkSeq: offset,
        chunksWritten,
        completed: offset >= chunks.length,
      }),
    );
  }
  const checkpoint = buildCheckpoint({
    plan,
    nextChunkSeq: chunks.length,
    chunksWritten,
    completed: true,
  });
  const verification =
    shouldVerifyAfterWrite && options.destinationAdapter.listTranscriptChunks
      ? await verifyWrittenTranscriptChunks({
          adapter: options.destinationAdapter as SessionStoreAdapter &
            Required<Pick<SessionStoreAdapter, "listTranscriptChunks">>,
          storePath: options.storePath,
          sessionKey: options.sessionKey,
          transcriptPath: options.transcriptPath,
          expectedChunks: chunks,
          pageSize: batchSize,
        })
      : buildUnrequestedVerification(chunks);
  if (shouldVerifyAfterWrite && !verification.ok) {
    throw new TranscriptJsonlMigrationError(
      `Transcript JSONL migration verification failed with ${verification.issues.length} issue${verification.issues.length === 1 ? "" : "s"}`,
      {
        plan,
        checkpoint,
      },
    );
  }

  return {
    mode,
    applied: true,
    verified: verification.ok,
    verification,
    plan,
    checkpoint,
  };
}
