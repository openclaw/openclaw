import { createHash } from "node:crypto";
import type { SessionStoreAdapter, SessionTurnRecord } from "./storage-adapter.js";
import {
  collectTranscriptJsonlChunks,
  type TranscriptJsonlMalformedLine,
} from "./transcript-chunk-migration.js";

export type SessionTurnMigrationMode = "dry-run" | "apply";

export type SessionTurnMigrationSkippedLine = {
  lineNumber: number;
  chunkSeq: number;
  reason: string;
};

export type SessionTurnMigrationPlan = {
  storePath: string;
  sessionKey: string;
  transcriptPath?: string;
  sourceFingerprint: string;
  sourceChunkCount: number;
  sourceLineCount: number;
  turnCount: number;
  malformedLines: TranscriptJsonlMalformedLine[];
  skippedLines: SessionTurnMigrationSkippedLine[];
};

export type SessionTurnMigrationCheckpoint = {
  storePath: string;
  sessionKey: string;
  sourceFingerprint: string;
  batchSize: number;
  nextTurnOffset: number;
  turnsWritten: number;
  completed: boolean;
};

export type SessionTurnMigrationVerificationIssueCode =
  | "total_count_mismatch"
  | "turn_count_mismatch"
  | "turn_missing"
  | "turn_mismatch"
  | "pagination_stalled";

export type SessionTurnMigrationVerificationIssue = {
  code: SessionTurnMigrationVerificationIssueCode;
  message: string;
  turnSeq?: number;
  expected?: unknown;
  observed?: unknown;
};

export type SessionTurnMigrationVerification = {
  requested: boolean;
  ok: boolean;
  turnsExpected: number;
  turnsRead: number;
  totalCount: number;
  issues: SessionTurnMigrationVerificationIssue[];
};

export type SessionTurnMigrationResult = {
  mode: SessionTurnMigrationMode;
  applied: boolean;
  verified: boolean;
  verification: SessionTurnMigrationVerification;
  plan: SessionTurnMigrationPlan;
  checkpoint: SessionTurnMigrationCheckpoint;
};

export type CollectedSessionTurns = {
  plan: SessionTurnMigrationPlan;
  turns: SessionTurnRecord[];
};

export type SessionTurnMigrationOptions = {
  destinationAdapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
  transcriptPath: string;
  mode?: SessionTurnMigrationMode;
  batchSize: number;
  checkpoint?: SessionTurnMigrationCheckpoint;
  skipMalformed?: boolean;
  agentId?: string;
  verifyAfterWrite?: boolean;
  maxLinesPerChunk?: number;
  maxBytesPerChunk?: number;
  onCheckpoint?: (checkpoint: SessionTurnMigrationCheckpoint) => void | Promise<void>;
};

export class SessionTurnMigrationError extends Error {
  readonly plan: SessionTurnMigrationPlan;
  readonly checkpoint: SessionTurnMigrationCheckpoint;

  constructor(
    message: string,
    params: { plan: SessionTurnMigrationPlan; checkpoint: SessionTurnMigrationCheckpoint },
  ) {
    super(message);
    this.name = "SessionTurnMigrationError";
    this.plan = params.plan;
    this.checkpoint = params.checkpoint;
  }
}

type TranscriptLineSource = {
  chunkSeq: number;
  lineNumber: number;
  transcriptPath?: string;
  value: unknown;
};

type ModelSnapshot = {
  provider?: string;
  model?: string;
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function maybeUpdateModelSnapshot(value: unknown, current: ModelSnapshot): ModelSnapshot {
  const record = asRecord(value);
  if (!record) {
    return current;
  }
  if (record.type === "model_change") {
    return {
      provider: firstString(stringField(record, "provider"), current.provider),
      model: firstString(
        stringField(record, "model"),
        stringField(record, "modelId"),
        current.model,
      ),
    };
  }
  if (record.type === "custom" && record.customType === "model-snapshot") {
    const data = asRecord(record.data);
    return {
      provider: firstString(stringField(data, "provider"), current.provider),
      model: firstString(stringField(data, "model"), stringField(data, "modelId"), current.model),
    };
  }
  return current;
}

function extractTokenUsage(record: Record<string, unknown>, message: Record<string, unknown>) {
  const recordUsage = asRecord(record.usage);
  const messageUsage = asRecord(message.usage);
  const usage = asRecord(message.usage) ?? asRecord(record.usage);
  return {
    inputTokens: firstNumber(
      numberField(messageUsage, "inputTokens"),
      numberField(messageUsage, "input_tokens"),
      numberField(messageUsage, "promptTokens"),
      numberField(messageUsage, "prompt_tokens"),
      numberField(usage, "inputTokens"),
      numberField(recordUsage, "prompt_tokens"),
    ),
    outputTokens: firstNumber(
      numberField(messageUsage, "outputTokens"),
      numberField(messageUsage, "output_tokens"),
      numberField(messageUsage, "completionTokens"),
      numberField(messageUsage, "completion_tokens"),
      numberField(usage, "outputTokens"),
      numberField(recordUsage, "completion_tokens"),
    ),
  };
}

function extractTurnFromLine(params: {
  source: TranscriptLineSource;
  turnSeq: number;
  modelSnapshot: ModelSnapshot;
}): SessionTurnRecord | undefined {
  const record = asRecord(params.source.value);
  if (!record) {
    return undefined;
  }
  const message = asRecord(record.message) ?? record;
  const role = stringField(message, "role");
  if (!role || (record.type !== "message" && !asRecord(record.message))) {
    return undefined;
  }
  const provider = firstString(
    stringField(message, "provider"),
    stringField(message, "modelProvider"),
    stringField(record, "provider"),
    stringField(record, "modelProvider"),
    params.modelSnapshot.provider,
  );
  const model = firstString(
    stringField(message, "model"),
    stringField(message, "modelId"),
    stringField(record, "model"),
    stringField(record, "modelId"),
    params.modelSnapshot.model,
  );
  const startedAt = normalizeTimestamp(
    message.startedAt ?? record.startedAt ?? message.timestamp ?? record.timestamp,
  );
  const endedAt = normalizeTimestamp(
    message.endedAt ?? record.endedAt ?? message.timestamp ?? record.timestamp,
  );
  const { inputTokens, outputTokens } = extractTokenUsage(record, message);
  return {
    turnSeq: params.turnSeq,
    role,
    ...(provider ? { modelProvider: provider } : {}),
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    metadataJson: {
      source: "transcript-jsonl",
      lineNumber: params.source.lineNumber,
      chunkSeq: params.source.chunkSeq,
      ...(params.source.transcriptPath ? { transcriptPath: params.source.transcriptPath } : {}),
      ...(stringField(record, "id") ? { messageId: stringField(record, "id") } : {}),
      ...(stringField(record, "parentId") ? { parentId: stringField(record, "parentId") } : {}),
      ...(stringField(record, "type") ? { recordType: stringField(record, "type") } : {}),
    },
  };
}

function buildSourceFingerprint(params: {
  storePath: string;
  sessionKey: string;
  transcriptPath?: string;
  sourceTranscriptSha256?: string;
  chunks: readonly {
    chunkSeq: number;
    transcriptPath?: string;
    contentSha256: string;
    bytes: number;
  }[];
}): string {
  if (params.sourceTranscriptSha256) {
    return params.sourceTranscriptSha256;
  }
  return sha256(
    stableJson({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      transcriptPath: params.transcriptPath,
      chunks: params.chunks.map((chunk) => ({
        chunkSeq: chunk.chunkSeq,
        transcriptPath: chunk.transcriptPath,
        contentSha256: chunk.contentSha256,
        bytes: chunk.bytes,
      })),
    }),
  );
}

function buildCheckpoint(params: {
  plan: SessionTurnMigrationPlan;
  batchSize: number;
  nextTurnOffset: number;
  turnsWritten: number;
  completed: boolean;
}): SessionTurnMigrationCheckpoint {
  return {
    storePath: params.plan.storePath,
    sessionKey: params.plan.sessionKey,
    sourceFingerprint: params.plan.sourceFingerprint,
    batchSize: params.batchSize,
    nextTurnOffset: params.nextTurnOffset,
    turnsWritten: params.turnsWritten,
    completed: params.completed,
  };
}

function assertCheckpointMatches(
  checkpoint: SessionTurnMigrationCheckpoint,
  plan: SessionTurnMigrationPlan,
  batchSize: number,
): void {
  if (
    checkpoint.storePath !== plan.storePath ||
    checkpoint.sessionKey !== plan.sessionKey ||
    checkpoint.sourceFingerprint !== plan.sourceFingerprint ||
    checkpoint.batchSize !== batchSize
  ) {
    throw new Error("Session turn migration checkpoint does not match current plan");
  }
}

function buildUnrequestedVerification(turns: readonly SessionTurnRecord[]) {
  return {
    requested: false,
    ok: false,
    turnsExpected: turns.length,
    turnsRead: 0,
    totalCount: 0,
    issues: [],
  } satisfies SessionTurnMigrationVerification;
}

function addVerificationIssue(
  issues: SessionTurnMigrationVerificationIssue[],
  issue: SessionTurnMigrationVerificationIssue,
): void {
  issues.push(issue);
}

async function readAllSessionTurnsForVerification(params: {
  adapter: SessionStoreAdapter & Required<Pick<SessionStoreAdapter, "listSessionTurns">>;
  storePath: string;
  sessionKey: string;
  pageSize: number;
}): Promise<{ turns: SessionTurnRecord[]; totalCount: number; stalled: boolean }> {
  const turns: SessionTurnRecord[] = [];
  let totalCount = 0;
  let offset = 0;
  let stalled = false;
  for (;;) {
    const result = await params.adapter.listSessionTurns(params.storePath, params.sessionKey, {
      limit: params.pageSize,
      offset,
      orderBy: "turnSeq_asc",
    });
    totalCount = result.totalCount;
    turns.push(...result.turns);
    if (!result.hasMore) {
      break;
    }
    const nextOffset = result.nextOffset ?? offset + result.turns.length;
    if (nextOffset <= offset || result.turns.length === 0) {
      stalled = true;
      break;
    }
    offset = nextOffset;
  }
  return { turns, totalCount, stalled };
}

function normalizeTurnForComparison(turn: SessionTurnRecord): SessionTurnRecord {
  return {
    turnSeq: turn.turnSeq,
    role: turn.role,
    ...(turn.modelProvider ? { modelProvider: turn.modelProvider } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(turn.startedAt ? { startedAt: normalizeTimestamp(turn.startedAt) ?? turn.startedAt } : {}),
    ...(turn.endedAt ? { endedAt: normalizeTimestamp(turn.endedAt) ?? turn.endedAt } : {}),
    metadataJson: turn.metadataJson ?? {},
  };
}

async function verifyWrittenSessionTurns(params: {
  adapter: SessionStoreAdapter & Required<Pick<SessionStoreAdapter, "listSessionTurns">>;
  storePath: string;
  sessionKey: string;
  expectedTurns: readonly SessionTurnRecord[];
  pageSize: number;
}): Promise<SessionTurnMigrationVerification> {
  const read = await readAllSessionTurnsForVerification({
    adapter: params.adapter,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    pageSize: params.pageSize,
  });
  const issues: SessionTurnMigrationVerificationIssue[] = [];
  if (read.stalled) {
    addVerificationIssue(issues, {
      code: "pagination_stalled",
      message: "Session turn verification pagination did not advance",
    });
  }
  if (read.totalCount !== params.expectedTurns.length) {
    addVerificationIssue(issues, {
      code: "total_count_mismatch",
      message: "Session turn verification total count does not match migration plan",
      expected: params.expectedTurns.length,
      observed: read.totalCount,
    });
  }
  if (read.turns.length !== params.expectedTurns.length) {
    addVerificationIssue(issues, {
      code: "turn_count_mismatch",
      message: "Session turn verification read count does not match migration plan",
      expected: params.expectedTurns.length,
      observed: read.turns.length,
    });
  }
  const observedBySeq = new Map(read.turns.map((turn) => [turn.turnSeq, turn]));
  for (const expected of params.expectedTurns) {
    const observed = observedBySeq.get(expected.turnSeq);
    if (!observed) {
      addVerificationIssue(issues, {
        code: "turn_missing",
        message: "Session turn is missing from destination verification read",
        turnSeq: expected.turnSeq,
      });
      continue;
    }
    const expectedComparable = normalizeTurnForComparison(expected);
    const observedComparable = normalizeTurnForComparison(observed);
    if (stableJson(observedComparable) !== stableJson(expectedComparable)) {
      addVerificationIssue(issues, {
        code: "turn_mismatch",
        message: "Session turn does not match source turn",
        turnSeq: expected.turnSeq,
        expected: expectedComparable,
        observed: observedComparable,
      });
    }
  }
  return {
    requested: true,
    ok: issues.length === 0,
    turnsExpected: params.expectedTurns.length,
    turnsRead: read.turns.length,
    totalCount: read.totalCount,
    issues,
  };
}

export function collectSessionTurnsFromTranscriptChunks(params: {
  storePath: string;
  sessionKey: string;
  chunks: readonly {
    chunkSeq: number;
    transcriptPath?: string;
    contentSha256: string;
    bytes: number;
    chunkJson: { startLine: number; lines: unknown[] };
  }[];
  transcriptPath?: string;
  sourceTranscriptSha256?: string;
  malformedLines?: TranscriptJsonlMalformedLine[];
}): CollectedSessionTurns {
  const chunks = [...params.chunks].toSorted((left, right) => left.chunkSeq - right.chunkSeq);
  const turns: SessionTurnRecord[] = [];
  const skippedLines: SessionTurnMigrationSkippedLine[] = [];
  let modelSnapshot: ModelSnapshot = {};
  let sourceLineCount = 0;
  for (const chunk of chunks) {
    const startLine = Math.max(1, Math.floor(chunk.chunkJson.startLine));
    for (let index = 0; index < chunk.chunkJson.lines.length; index += 1) {
      sourceLineCount += 1;
      const source: TranscriptLineSource = {
        chunkSeq: chunk.chunkSeq,
        lineNumber: startLine + index,
        transcriptPath: chunk.transcriptPath ?? params.transcriptPath,
        value: chunk.chunkJson.lines[index],
      };
      const nextSnapshot = maybeUpdateModelSnapshot(source.value, modelSnapshot);
      modelSnapshot = nextSnapshot;
      const turn = extractTurnFromLine({ source, turnSeq: turns.length, modelSnapshot });
      if (turn) {
        turns.push(turn);
        continue;
      }
      const record = asRecord(source.value);
      if (record?.type === "message" || asRecord(record?.message)) {
        skippedLines.push({
          lineNumber: source.lineNumber,
          chunkSeq: source.chunkSeq,
          reason: "message record did not contain a string role",
        });
      }
    }
  }
  const plan: SessionTurnMigrationPlan = {
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    ...(params.transcriptPath ? { transcriptPath: params.transcriptPath } : {}),
    sourceFingerprint: buildSourceFingerprint({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      transcriptPath: params.transcriptPath,
      sourceTranscriptSha256: params.sourceTranscriptSha256,
      chunks,
    }),
    sourceChunkCount: chunks.length,
    sourceLineCount,
    turnCount: turns.length,
    malformedLines: params.malformedLines ? [...params.malformedLines] : [],
    skippedLines,
  };
  return { plan, turns };
}

export async function collectSessionTurnsFromTranscriptJsonl(params: {
  transcriptPath: string;
  storePath: string;
  sessionKey: string;
  maxLinesPerChunk?: number;
  maxBytesPerChunk?: number;
}): Promise<CollectedSessionTurns> {
  const collected = await collectTranscriptJsonlChunks({
    transcriptPath: params.transcriptPath,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    maxLinesPerChunk: params.maxLinesPerChunk,
    maxBytesPerChunk: params.maxBytesPerChunk,
  });
  return collectSessionTurnsFromTranscriptChunks({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    transcriptPath: params.transcriptPath,
    sourceTranscriptSha256: collected.plan.transcriptSha256,
    malformedLines: collected.plan.malformedLines,
    chunks: collected.chunks,
  });
}

export async function migrateTranscriptJsonlSessionTurnsToAdapter(
  options: SessionTurnMigrationOptions,
): Promise<SessionTurnMigrationResult> {
  const mode = options.mode ?? "dry-run";
  const batchSize = normalizePositiveInteger(options.batchSize, 1, "batchSize");
  const { plan, turns } = await collectSessionTurnsFromTranscriptJsonl({
    transcriptPath: options.transcriptPath,
    storePath: options.storePath,
    sessionKey: options.sessionKey,
    maxLinesPerChunk: options.maxLinesPerChunk,
    maxBytesPerChunk: options.maxBytesPerChunk,
  });
  if (options.checkpoint) {
    assertCheckpointMatches(options.checkpoint, plan, batchSize);
  }
  if (plan.malformedLines.length > 0 && options.skipMalformed !== true) {
    throw new SessionTurnMigrationError(
      `Session turn migration encountered ${plan.malformedLines.length} malformed transcript line${plan.malformedLines.length === 1 ? "" : "s"}`,
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          batchSize,
          nextTurnOffset: options.checkpoint?.nextTurnOffset ?? 0,
          turnsWritten: options.checkpoint?.turnsWritten ?? 0,
          completed: false,
        }),
      },
    );
  }
  if (mode === "dry-run") {
    return {
      mode,
      applied: false,
      verified: false,
      verification: buildUnrequestedVerification(turns),
      plan,
      checkpoint: buildCheckpoint({
        plan,
        batchSize,
        nextTurnOffset: options.checkpoint?.nextTurnOffset ?? 0,
        turnsWritten: options.checkpoint?.turnsWritten ?? 0,
        completed: false,
      }),
    };
  }
  if (!options.destinationAdapter.writeSessionTurns) {
    throw new SessionTurnMigrationError(
      "Destination adapter does not support session turn writes",
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          batchSize,
          nextTurnOffset: options.checkpoint?.nextTurnOffset ?? 0,
          turnsWritten: options.checkpoint?.turnsWritten ?? 0,
          completed: false,
        }),
      },
    );
  }
  const shouldVerifyAfterWrite = options.verifyAfterWrite !== false;
  if (shouldVerifyAfterWrite && !options.destinationAdapter.listSessionTurns) {
    throw new SessionTurnMigrationError(
      "Destination adapter does not support session turn verification reads",
      {
        plan,
        checkpoint: buildCheckpoint({
          plan,
          batchSize,
          nextTurnOffset: options.checkpoint?.nextTurnOffset ?? 0,
          turnsWritten: options.checkpoint?.turnsWritten ?? 0,
          completed: false,
        }),
      },
    );
  }

  let turnsWritten = options.checkpoint?.turnsWritten ?? 0;
  for (let offset = options.checkpoint?.nextTurnOffset ?? 0; offset < turns.length; ) {
    const batch = turns.slice(offset, offset + batchSize);
    await options.destinationAdapter.writeSessionTurns(
      options.storePath,
      options.sessionKey,
      batch,
      options.agentId
        ? { agentId: options.agentId, skipMaintenance: true }
        : { skipMaintenance: true },
    );
    offset += batch.length;
    turnsWritten += batch.length;
    await options.onCheckpoint?.(
      buildCheckpoint({
        plan,
        batchSize,
        nextTurnOffset: offset,
        turnsWritten,
        completed: offset >= turns.length,
      }),
    );
  }
  const checkpoint = buildCheckpoint({
    plan,
    batchSize,
    nextTurnOffset: turns.length,
    turnsWritten,
    completed: true,
  });
  const verification =
    shouldVerifyAfterWrite && options.destinationAdapter.listSessionTurns
      ? await verifyWrittenSessionTurns({
          adapter: options.destinationAdapter as SessionStoreAdapter &
            Required<Pick<SessionStoreAdapter, "listSessionTurns">>,
          storePath: options.storePath,
          sessionKey: options.sessionKey,
          expectedTurns: turns,
          pageSize: batchSize,
        })
      : buildUnrequestedVerification(turns);
  if (shouldVerifyAfterWrite && !verification.ok) {
    throw new SessionTurnMigrationError(
      `Session turn migration verification failed with ${verification.issues.length} issue${verification.issues.length === 1 ? "" : "s"}`,
      { plan, checkpoint },
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
