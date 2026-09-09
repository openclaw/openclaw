/** Core bounded metadata helpers for channel ingress observability. */

import {
  CHANNEL_INGRESS_BLOCKERS,
  CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY,
  CHANNEL_INGRESS_OBSERVABILITY_OWNER,
  CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
  CHANNEL_INGRESS_OPERATION_KINDS,
  CHANNEL_INGRESS_PREPARATION_STAGES,
  type ChannelIngressBlocker,
  type ChannelIngressCorrelation,
  type ChannelIngressHistoricalOperationSnapshot,
  type ChannelIngressOperationKind,
  type ChannelIngressOperationOutcome,
  type ChannelIngressOperationSnapshot,
  type ChannelIngressPreparationStage,
  type ChannelIngressProgressMetadataV1,
  type ChannelIngressProgressUpdate,
} from "./ingress-observability-contract.js";

type MetadataObject = Record<string, unknown>;

const STRING_LIMIT = 160;
const MAX_ACTIVE_OPERATIONS = 8;

function hasOwnMetadataKey(metadata: MetadataObject, key: string): boolean {
  return Object.hasOwn(metadata, key);
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > STRING_LIMIT ? `${trimmed.slice(0, STRING_LIMIT)}...` : trimmed;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function isMetadataObject(value: unknown): value is MetadataObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadataObject(metadataJson: string | null): MetadataObject | null {
  if (metadataJson === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return isMetadataObject(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

function parseStage(value: unknown): ChannelIngressPreparationStage | undefined {
  return typeof value === "string"
    ? CHANNEL_INGRESS_PREPARATION_STAGES.find((stage) => stage === value)
    : undefined;
}

function parseBlocker(value: unknown): ChannelIngressBlocker | undefined {
  return typeof value === "string"
    ? CHANNEL_INGRESS_BLOCKERS.find((blocker) => blocker === value)
    : undefined;
}

function parseOperationKind(value: unknown): ChannelIngressOperationKind | undefined {
  return typeof value === "string"
    ? CHANNEL_INGRESS_OPERATION_KINDS.find((kind) => kind === value)
    : undefined;
}

function parseOperationOutcome(value: unknown): ChannelIngressOperationOutcome | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "unknown"
    ? value
    : undefined;
}

function parseCorrelation(value: unknown): ChannelIngressCorrelation | undefined {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const correlation: ChannelIngressCorrelation = {};
  const providerEventType = boundedString(value.providerEventType);
  const teamId = boundedString(value.teamId);
  const channelId = boundedString(value.channelId);
  const messageTs = boundedString(value.messageTs);
  const threadTs = boundedString(value.threadTs);
  const sessionId = boundedString(value.sessionId);
  const runId = boundedString(value.runId);
  if (providerEventType) {
    correlation.providerEventType = providerEventType;
  }
  if (teamId) {
    correlation.teamId = teamId;
  }
  if (channelId) {
    correlation.channelId = channelId;
  }
  if (messageTs) {
    correlation.messageTs = messageTs;
  }
  if (threadTs) {
    correlation.threadTs = threadTs;
  }
  if (sessionId) {
    correlation.sessionId = sessionId;
  }
  if (runId) {
    correlation.runId = runId;
  }
  return Object.keys(correlation).length === 0 ? undefined : correlation;
}

function parseOperationSnapshot(value: unknown): ChannelIngressOperationSnapshot | undefined {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const id = boundedString(value.id);
  const kind = parseOperationKind(value.kind);
  const startedAt = finiteTimestamp(value.startedAt);
  if (!id || !kind || startedAt === undefined) {
    return undefined;
  }
  const method = boundedString(value.method);
  const profile = boundedString(value.profile);
  return {
    id,
    kind,
    startedAt,
    ...(method ? { method } : {}),
    ...(profile ? { profile } : {}),
  };
}

function toHistoricalOperation(
  operation: ChannelIngressOperationSnapshot,
  params: { outcome?: ChannelIngressOperationOutcome; finishedAt?: number } = {},
): ChannelIngressHistoricalOperationSnapshot {
  return {
    ...operation,
    historical: true,
    ...(params.outcome ? { outcome: params.outcome } : {}),
    ...(params.finishedAt === undefined ? {} : { finishedAt: params.finishedAt }),
  };
}

function parseHistoricalOperation(
  value: unknown,
): ChannelIngressHistoricalOperationSnapshot | undefined {
  const operation = parseOperationSnapshot(value);
  if (!operation || !isMetadataObject(value) || value.historical !== true) {
    return undefined;
  }
  const outcome = parseOperationOutcome(value.outcome);
  const finishedAt = finiteTimestamp(value.finishedAt);
  return toHistoricalOperation(operation, {
    ...(outcome ? { outcome } : {}),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  });
}

function parseMetadataRoot(metadataJson: string | null): {
  metadata: MetadataObject | null;
  preserveOriginal: string | null;
} {
  if (metadataJson === null) {
    return { metadata: {}, preserveOriginal: null };
  }
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return isMetadataObject(parsed)
      ? { metadata: { ...parsed }, preserveOriginal: null }
      : { metadata: null, preserveOriginal: metadataJson };
  } catch {
    return { metadata: null, preserveOriginal: metadataJson };
  }
}

function mergeCorrelation(
  previous: ChannelIngressCorrelation | undefined,
  update: ChannelIngressCorrelation | undefined,
): ChannelIngressCorrelation | undefined {
  const parsedUpdate = parseCorrelation(update);
  const merged: ChannelIngressCorrelation = {};
  if (previous) {
    Object.assign(merged, previous);
  }
  if (parsedUpdate) {
    Object.assign(merged, parsedUpdate);
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function parseLastPreparation(value: unknown): ChannelIngressProgressMetadataV1["lastPreparation"] {
  if (!isMetadataObject(value)) {
    return undefined;
  }
  const stage = parseStage(value.stage);
  const blocker = parseBlocker(value.blocker);
  const stageStartedAt = finiteTimestamp(value.stageStartedAt);
  const completedAt = finiteTimestamp(value.completedAt);
  const elapsedMs = finiteTimestamp(value.elapsedMs);
  if (
    !stage ||
    !blocker ||
    stageStartedAt === undefined ||
    completedAt === undefined ||
    elapsedMs === undefined
  ) {
    return undefined;
  }
  return { stage, blocker, stageStartedAt, completedAt, elapsedMs };
}

export function readChannelIngressProgressMetadata(
  metadataJson: string | null,
): ChannelIngressProgressMetadataV1 | undefined {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    return undefined;
  }
  const raw = metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY];
  if (
    !isMetadataObject(raw) ||
    raw.owner !== CHANNEL_INGRESS_OBSERVABILITY_OWNER ||
    raw.schemaVersion !== CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION
  ) {
    return undefined;
  }
  const stage = parseStage(raw.stage);
  const blocker = parseBlocker(raw.blocker);
  const stageStartedAt = finiteTimestamp(raw.stageStartedAt);
  const updatedAt = finiteTimestamp(raw.updatedAt);
  if (!stage || !blocker || stageStartedAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const lastProgressAt = finiteTimestamp(raw.lastProgressAt);
  const activeOperations = Array.isArray(raw.activeOperations)
    ? raw.activeOperations.flatMap((operation) => {
        const parsed = parseOperationSnapshot(operation);
        return parsed ? [parsed] : [];
      })
    : undefined;
  const lastOperation = parseHistoricalOperation(raw.lastOperation);
  const lastPreparation = parseLastPreparation(raw.lastPreparation);
  const correlation = parseCorrelation(raw.correlation);
  let terminal: ChannelIngressProgressMetadataV1["terminal"];
  if (isMetadataObject(raw.terminal)) {
    const disposition = raw.terminal.disposition;
    const recordedAt = finiteTimestamp(raw.terminal.recordedAt);
    if ((disposition === "completed" || disposition === "failed") && recordedAt !== undefined) {
      terminal = { disposition, recordedAt };
    }
  }
  return {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage,
    blocker,
    stageStartedAt,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    updatedAt,
    ...(activeOperations && activeOperations.length > 0 ? { activeOperations } : {}),
    ...(lastOperation ? { lastOperation } : {}),
    ...(lastPreparation ? { lastPreparation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

export function initializeChannelIngressProgressMetadata(
  metadataJson: string | null,
  receivedAt: number,
): string | null {
  const { metadata, preserveOriginal } = parseMetadataRoot(metadataJson);
  if (metadata === null) {
    return preserveOriginal;
  }
  if (hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)) {
    return metadataJson;
  }
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage: "queued",
    blocker: "none",
    stageStartedAt: receivedAt,
    lastProgressAt: receivedAt,
    updatedAt: receivedAt,
  } satisfies ChannelIngressProgressMetadataV1;
  return JSON.stringify(metadata);
}

export function mergeChannelIngressProgressMetadata(
  metadataJson: string | null,
  update: ChannelIngressProgressUpdate,
  defaultObservedAt: number,
): string | null {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    // Non-object provider metadata remains byte-for-byte owned by the provider.
    // The queue treats this as an unsupported observation write and leaves claim,
    // retry, and provider metadata unchanged while snapshots report unknown progress.
    return null;
  }
  const previous = readChannelIngressProgressMetadata(metadataJson);
  if (
    previous === undefined &&
    hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)
  ) {
    return null;
  }
  const observedAt = finiteTimestamp(update.observedAt) ?? defaultObservedAt;
  const stage = update.stage ?? previous?.stage ?? "queued";
  const blocker = update.blocker ?? previous?.blocker ?? "none";
  const stageChanged = previous?.stage !== undefined && previous.stage !== stage;
  const stageStartedAt =
    finiteTimestamp(update.stageStartedAt) ??
    (stageChanged ? observedAt : previous?.stageStartedAt) ??
    observedAt;
  let activeOperations = previous?.activeOperations ? [...previous.activeOperations] : [];
  let lastOperation = previous?.lastOperation;
  if (update.operation?.phase === "begin") {
    const id = boundedString(update.operation.id);
    const kind = parseOperationKind(update.operation.kind);
    const startedAt = finiteTimestamp(update.operation.startedAt) ?? observedAt;
    if (id && kind) {
      activeOperations = [
        ...activeOperations.filter((operation) => operation.id !== id),
        {
          id,
          kind,
          startedAt,
          ...(boundedString(update.operation.method)
            ? { method: boundedString(update.operation.method) }
            : {}),
          ...(boundedString(update.operation.profile)
            ? { profile: boundedString(update.operation.profile) }
            : {}),
        },
      ].slice(-MAX_ACTIVE_OPERATIONS);
    }
  } else if (update.operation?.phase === "finish") {
    const id = boundedString(update.operation.id);
    if (id) {
      const operation = activeOperations.find((entry) => entry.id === id);
      activeOperations = activeOperations.filter((entry) => entry.id !== id);
      if (operation) {
        lastOperation = toHistoricalOperation(operation, {
          outcome: update.operation.outcome ?? "completed",
          finishedAt: finiteTimestamp(update.operation.finishedAt) ?? observedAt,
        });
      }
    }
  }
  const correlation = mergeCorrelation(previous?.correlation, update.correlation);
  const lastProgressAt = finiteTimestamp(update.progressAt) ?? previous?.lastProgressAt;
  const lastPreparation =
    previous && stage === "adoption" && previous.stage !== "adoption"
      ? {
          stage: previous.stage,
          blocker: previous.blocker,
          stageStartedAt: previous.stageStartedAt,
          completedAt: observedAt,
          elapsedMs: Math.max(0, observedAt - previous.stageStartedAt),
        }
      : previous?.lastPreparation;
  const progress: ChannelIngressProgressMetadataV1 = {
    owner: CHANNEL_INGRESS_OBSERVABILITY_OWNER,
    schemaVersion: CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION,
    stage,
    blocker,
    stageStartedAt,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    updatedAt: observedAt,
    ...(activeOperations.length > 0 ? { activeOperations } : {}),
    ...(lastOperation ? { lastOperation } : {}),
    ...(lastPreparation ? { lastPreparation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(previous?.terminal ? { terminal: previous.terminal } : {}),
  };
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = progress;
  return JSON.stringify(metadata);
}

export function freezeChannelIngressProgressMetadata(params: {
  metadataJson: string | null;
  completedMetadata?: unknown;
  disposition: "completed" | "failed";
  reason?: string;
  recordedAt: number;
}): { metadataJson: string | null; completedMetadataJson: string | null } {
  const progress = readChannelIngressProgressMetadata(params.metadataJson);
  const terminalProgress = progress
    ? (() => {
        const { activeOperations, ...settledProgress } = progress;
        const terminalLastOperation =
          settledProgress.lastOperation ??
          (activeOperations?.[0]
            ? toHistoricalOperation(activeOperations[0], { outcome: "unknown" })
            : undefined);
        const completedLastPreparation =
          params.disposition !== "completed" || settledProgress.stage === "adoption"
            ? settledProgress.lastPreparation
            : {
                stage: settledProgress.stage,
                blocker: settledProgress.blocker,
                stageStartedAt: settledProgress.stageStartedAt,
                completedAt: params.recordedAt,
                elapsedMs: Math.max(0, params.recordedAt - settledProgress.stageStartedAt),
              };
        return {
          ...settledProgress,
          ...(params.disposition === "completed"
            ? {
                stage: "adoption" as const,
                blocker: "none" as const,
                stageStartedAt:
                  settledProgress.stage === "adoption"
                    ? settledProgress.stageStartedAt
                    : params.recordedAt,
                lastProgressAt: params.recordedAt,
              }
            : {}),
          ...(terminalLastOperation ? { lastOperation: terminalLastOperation } : {}),
          ...(completedLastPreparation ? { lastPreparation: completedLastPreparation } : {}),
          updatedAt: params.recordedAt,
          terminal: {
            disposition: params.disposition,
            recordedAt: params.recordedAt,
          },
        };
      })()
    : undefined;
  const completed =
    params.completedMetadata === undefined
      ? {}
      : isMetadataObject(params.completedMetadata)
        ? { ...params.completedMetadata }
        : params.completedMetadata;
  const completedMetadata =
    terminalProgress &&
    isMetadataObject(completed) &&
    !hasOwnMetadataKey(completed, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY)
      ? { ...completed, [CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY]: terminalProgress }
      : completed;
  const completedMetadataJson =
    params.completedMetadata === undefined && terminalProgress === undefined
      ? null
      : JSON.stringify(completedMetadata);

  const metadata = parseMetadataObject(params.metadataJson);
  if (metadata === null || terminalProgress === undefined) {
    return { metadataJson: params.metadataJson, completedMetadataJson };
  }
  metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY] = terminalProgress;
  return { metadataJson: JSON.stringify(metadata), completedMetadataJson };
}

export function clearChannelIngressProgressMetadata(metadataJson: string | null): string | null {
  const metadata = parseMetadataObject(metadataJson);
  if (metadata === null) {
    return metadataJson;
  }
  if (
    hasOwnMetadataKey(metadata, CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY) &&
    readChannelIngressProgressMetadata(metadataJson) === undefined
  ) {
    return metadataJson;
  }
  delete metadata[CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY];
  return Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata);
}
