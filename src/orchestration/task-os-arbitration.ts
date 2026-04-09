import { createHash, randomUUID } from "node:crypto";
import {
  loadOpenClawControlPlanePolicy,
  resolveControlPlaneSourceTruthSystemPolicy,
} from "../infra/control-plane-policy.js";

export const TASK_SOURCE_KINDS = [
  "slack",
  "telegram",
  "gmail",
  "jira",
  "notion",
  "github",
  "research",
] as const;
export const TASK_FINGERPRINT_KINDS = [
  "canonical",
  "source",
  "idempotency",
  "external_link",
] as const;
export const TASK_RESOLUTION_STATES = ["open", "resolved", "reopened", "dismissed"] as const;
export const TASK_RECONCILIATION_STATES = ["canonical", "reconciled", "stale", "conflict"] as const;
export const TASK_CONFIDENCE_LABELS = ["low", "medium", "high"] as const;
export const TASK_ARBITRATION_ACTIONS = [
  "created",
  "source_attached",
  "delivery_deduped",
  "notification_suppressed",
  "resolved",
  "reopened",
  "reconciled",
  "stale_marked",
  "conflict_recorded",
] as const;

export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];
export type TaskFingerprintKind = (typeof TASK_FINGERPRINT_KINDS)[number];
export type TaskResolutionState = (typeof TASK_RESOLUTION_STATES)[number];
export type TaskReconciliationState = (typeof TASK_RECONCILIATION_STATES)[number];
export type TaskConfidenceLabel = (typeof TASK_CONFIDENCE_LABELS)[number];
export type TaskArbitrationAction = (typeof TASK_ARBITRATION_ACTIONS)[number];

export type TaskConfidenceInput = {
  score?: number;
  reason?: string;
};

export type TaskExternalLinkInput = {
  system: TaskSourceKind;
  externalId?: string;
  url?: string;
  title?: string;
  status?: string;
};

export type TaskCanonicalSourceInput = {
  sourceKind: TaskSourceKind;
  signalKind?: string;
  sourceId?: string;
  sourceFingerprint?: string;
  sameWorkKey?: string;
  idempotencyKey?: string;
  requestId?: string;
  sourceSurface?: string;
  observedAt?: string;
  title?: string;
  summary?: string;
  confidence?: TaskConfidenceInput;
  externalLinks?: TaskExternalLinkInput[];
  resolutionState?: TaskResolutionState;
  resolutionSummary?: string;
  reconciliationState?: TaskReconciliationState;
};

export type TaskCanonicalWorkInput = {
  source: TaskCanonicalSourceInput;
};

export type TaskFingerprintRecord = {
  kind: TaskFingerprintKind;
  value: string;
  sourceKind?: TaskSourceKind;
  createdAt: string;
};

export type TaskConfidenceRecord = {
  score: number;
  label: TaskConfidenceLabel;
  reason?: string;
  sourceKind?: TaskSourceKind;
  updatedAt: string;
};

export type TaskSourceProvenanceRecord = {
  sourceSurface?: string;
  sourceId?: string;
  requestId?: string;
  idempotencyKey: string;
  truthLayer: string;
  truthRank?: number;
  reconciliationMode?: string;
  allowCandidateTaskCreation: boolean;
  promoteToTaskTruth: boolean;
  observedAt: string;
};

export type TaskExternalLinkRecord = {
  id: string;
  system: TaskSourceKind;
  externalId?: string;
  url?: string;
  title?: string;
  status?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type TaskSourceRecord = {
  id: string;
  sourceKind: TaskSourceKind;
  signalKind?: string;
  title?: string;
  summary?: string;
  sourceFingerprint: string;
  idempotencyKey: string;
  provenance: TaskSourceProvenanceRecord;
  confidence?: TaskConfidenceRecord;
  externalLinkIds: string[];
  firstObservedAt: string;
  lastObservedAt: string;
  lastResolutionState?: TaskResolutionState;
};

export type TaskResolutionRecord = {
  state: TaskResolutionState;
  summary?: string;
  sourceKind?: TaskSourceKind;
  updatedAt: string;
  resolvedAt?: string;
};

export type TaskReconciliationRecord = {
  state: TaskReconciliationState;
  summary?: string;
  updatedAt: string;
  winnerSourceKind?: TaskSourceKind;
};

export type TaskArbitrationHistoryRecord = {
  id: string;
  action: TaskArbitrationAction;
  sourceKind?: TaskSourceKind;
  fingerprint: string;
  summary: string;
  createdAt: string;
};

export type TaskCanonicalWorkRecord = {
  canonicalFingerprint: string;
  fingerprints: TaskFingerprintRecord[];
  externalLinks: TaskExternalLinkRecord[];
  sources: TaskSourceRecord[];
  confidence?: TaskConfidenceRecord;
  resolution: TaskResolutionRecord;
  reconciliation: TaskReconciliationRecord;
  history: TaskArbitrationHistoryRecord[];
};

export type TaskCanonicalUpsertAction = "created" | "merged" | "idempotent";

export type TaskCanonicalMergeResult = {
  action: TaskCanonicalUpsertAction;
  canonicalWork: TaskCanonicalWorkRecord;
  resolutionTransition?: {
    from: TaskResolutionState;
    to: TaskResolutionState;
  };
  reconciliationTransition?: {
    from: TaskReconciliationState;
    to: TaskReconciliationState;
  };
  truthGate?: {
    blockedResolutionUpdate: boolean;
    blockedReconciliationUpdate: boolean;
  };
};

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function normalizeText(value: string | undefined | null): string {
  return (trimToUndefined(value) ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildFingerprint(prefix: string, values: Array<string | undefined>): string {
  const normalized = values.map((value) => normalizeText(value)).filter(Boolean);
  const payload = normalized.length ? normalized.join("|") : prefix;
  return `${prefix}:sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function ensureTaskSourceKind(kind: string): TaskSourceKind {
  const normalized = trimToUndefined(kind)?.toLowerCase();
  const matched = TASK_SOURCE_KINDS.find((entry) => entry === normalized);
  if (!matched) {
    throw new Error(`unsupported task source kind: ${kind}`);
  }
  return matched;
}

function laterTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a >= b ? a : b;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(trimToUndefined(value)))),
  );
}

function normalizeConfidence(
  input: TaskConfidenceInput | undefined,
  sourceKind: TaskSourceKind,
  updatedAt: string,
) {
  const score =
    typeof input?.score === "number" && Number.isFinite(input.score)
      ? Math.min(1, Math.max(0, input.score))
      : undefined;
  if (score === undefined) {
    return undefined;
  }
  const label: TaskConfidenceLabel = score >= 0.8 ? "high" : score >= 0.45 ? "medium" : "low";
  return {
    score,
    label,
    reason: trimToUndefined(input?.reason),
    sourceKind,
    updatedAt,
  } satisfies TaskConfidenceRecord;
}

function preferConfidence(
  current: TaskConfidenceRecord | undefined,
  next: TaskConfidenceRecord | undefined,
): TaskConfidenceRecord | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (next.score > current.score) {
    return next;
  }
  if (next.score === current.score && next.updatedAt >= current.updatedAt) {
    return next;
  }
  return current;
}

function buildExternalLinkRecord(
  input: TaskExternalLinkInput,
  observedAt: string,
): TaskExternalLinkRecord {
  const system = ensureTaskSourceKind(input.system);
  const externalId = trimToUndefined(input.externalId);
  const url = trimToUndefined(input.url);
  const title = trimToUndefined(input.title);
  if (!externalId && !url && !title) {
    throw new Error(`external link for ${system} requires externalId, url, or title`);
  }
  const id = buildFingerprint("external", [system, externalId, url, title]);
  return {
    id,
    system,
    externalId,
    url,
    title,
    status: trimToUndefined(input.status),
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
  };
}

function resolveTruthRank(layer: string | undefined): number | undefined {
  if (!layer) {
    return undefined;
  }
  return loadOpenClawControlPlanePolicy().sourceTruthLayers.find((entry) => entry.id === layer)
    ?.rank;
}

function buildSourceProvenanceRecord(
  input: TaskCanonicalSourceInput,
  observedAt: string,
  idempotencyKey: string,
) {
  const policy = resolveControlPlaneSourceTruthSystemPolicy(input.sourceKind);
  const truthLayer = policy?.layer ?? "raw_source_events";
  return {
    sourceSurface: trimToUndefined(input.sourceSurface),
    sourceId: trimToUndefined(input.sourceId),
    requestId: trimToUndefined(input.requestId),
    idempotencyKey,
    truthLayer,
    truthRank: resolveTruthRank(truthLayer),
    reconciliationMode: trimToUndefined(policy?.reconciliation_mode),
    allowCandidateTaskCreation: policy?.allow_candidate_task_creation === true,
    promoteToTaskTruth: policy?.promote_to_task_truth === true,
    observedAt,
  } satisfies TaskSourceProvenanceRecord;
}

function resolveCurrentTruthRank(
  current: TaskCanonicalWorkRecord,
  sourceKind: TaskSourceKind | undefined,
): number {
  if (!sourceKind) {
    return 99;
  }
  const currentSource = current.sources.find((entry) => entry.sourceKind === sourceKind);
  return currentSource?.provenance.truthRank ?? 99;
}

function resolveResolutionStateFromStatus(
  status: string | undefined,
): TaskResolutionState | undefined {
  const normalized = normalizeText(status);
  if (!normalized) {
    return undefined;
  }
  if (
    ["done", "closed", "resolved", "complete", "completed", "merged", "shipped"].includes(
      normalized,
    )
  ) {
    return "resolved";
  }
  if (
    ["dismissed", "cancelled", "canceled", "won t do", "wont do", "duplicate"].includes(normalized)
  ) {
    return "dismissed";
  }
  if (
    ["todo", "open", "pending", "backlog", "blocked", "in progress", "inprogress"].includes(
      normalized,
    )
  ) {
    return "open";
  }
  return undefined;
}

function resolveReconciliationStateFromStatus(
  status: string | undefined,
): TaskReconciliationState | undefined {
  const normalized = normalizeText(status);
  if (!normalized) {
    return undefined;
  }
  if (["stale", "archived", "obsolete", "superseded"].includes(normalized)) {
    return "stale";
  }
  if (["conflict", "diverged"].includes(normalized)) {
    return "conflict";
  }
  return undefined;
}

export function resolveCanonicalResolutionState(
  input: TaskCanonicalSourceInput,
): TaskResolutionState | undefined {
  if (input.resolutionState) {
    return input.resolutionState;
  }
  for (const link of input.externalLinks ?? []) {
    const resolved = resolveResolutionStateFromStatus(link.status);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function resolveCanonicalReconciliationState(
  input: TaskCanonicalSourceInput,
): TaskReconciliationState | undefined {
  if (input.reconciliationState) {
    return input.reconciliationState;
  }
  for (const link of input.externalLinks ?? []) {
    const reconciled = resolveReconciliationStateFromStatus(link.status);
    if (reconciled) {
      return reconciled;
    }
  }
  return undefined;
}

export function buildCanonicalTaskFingerprint(input: TaskCanonicalWorkInput): string {
  const sameWorkKey = trimToUndefined(input.source.sameWorkKey);
  if (sameWorkKey) {
    return buildFingerprint("work", [sameWorkKey]);
  }
  const normalizedContent =
    normalizeText(input.source.title) || normalizeText(input.source.summary);
  if (normalizedContent) {
    return buildFingerprint("work", [input.source.title, input.source.summary]);
  }
  const linkFingerprints = (input.source.externalLinks ?? [])
    .map(
      (link) =>
        buildExternalLinkRecord(link, input.source.observedAt ?? new Date().toISOString()).id,
    )
    .toSorted();
  if (linkFingerprints.length) {
    return buildFingerprint("work", linkFingerprints);
  }
  return buildFingerprint("work", [
    input.source.sourceFingerprint,
    input.source.sourceId,
    input.source.sourceKind,
  ]);
}

function buildSourceFingerprint(input: TaskCanonicalSourceInput): string {
  const explicit = trimToUndefined(input.sourceFingerprint);
  if (explicit) {
    return buildFingerprint("source", [input.sourceKind, explicit]);
  }
  return buildFingerprint("source", [
    input.sourceKind,
    input.sourceId,
    input.signalKind,
    input.title,
    input.summary,
  ]);
}

function buildIdempotencyKey(input: TaskCanonicalSourceInput, sourceFingerprint: string): string {
  const explicit = trimToUndefined(input.idempotencyKey);
  if (explicit) {
    return buildFingerprint("idempotency", [input.sourceKind, explicit]);
  }
  return buildFingerprint("idempotency", [input.sourceKind, input.sourceId, sourceFingerprint]);
}

function buildHistoryEntry(params: {
  action: TaskArbitrationAction;
  sourceKind?: TaskSourceKind;
  fingerprint: string;
  summary: string;
  createdAt: string;
}): TaskArbitrationHistoryRecord {
  return {
    id: randomUUID(),
    action: params.action,
    sourceKind: params.sourceKind,
    fingerprint: params.fingerprint,
    summary: params.summary,
    createdAt: params.createdAt,
  };
}

function buildFingerprintRecords(params: {
  canonicalFingerprint: string;
  sourceKind: TaskSourceKind;
  sourceFingerprint: string;
  idempotencyKey: string;
  externalLinks: TaskExternalLinkRecord[];
  observedAt: string;
}): TaskFingerprintRecord[] {
  const records: TaskFingerprintRecord[] = [
    {
      kind: "canonical",
      value: params.canonicalFingerprint,
      createdAt: params.observedAt,
    },
    {
      kind: "source",
      value: params.sourceFingerprint,
      sourceKind: params.sourceKind,
      createdAt: params.observedAt,
    },
    {
      kind: "idempotency",
      value: params.idempotencyKey,
      sourceKind: params.sourceKind,
      createdAt: params.observedAt,
    },
  ];
  for (const link of params.externalLinks) {
    records.push({
      kind: "external_link",
      value: link.id,
      sourceKind: link.system,
      createdAt: params.observedAt,
    });
  }
  return records;
}

function sortFingerprints(records: TaskFingerprintRecord[]): TaskFingerprintRecord[] {
  return records.toSorted((a, b) => a.value.localeCompare(b.value) || a.kind.localeCompare(b.kind));
}

function mergeFingerprints(
  current: TaskFingerprintRecord[],
  incoming: TaskFingerprintRecord[],
): TaskFingerprintRecord[] {
  const map = new Map<string, TaskFingerprintRecord>();
  for (const record of [...current, ...incoming]) {
    const key = `${record.kind}:${record.value}`;
    if (!map.has(key)) {
      map.set(key, record);
    }
  }
  return sortFingerprints(Array.from(map.values()));
}

function mergeExternalLinks(
  current: TaskExternalLinkRecord[],
  incoming: TaskExternalLinkRecord[],
): TaskExternalLinkRecord[] {
  const merged = new Map<string, TaskExternalLinkRecord>();
  for (const record of current) {
    merged.set(record.id, { ...record });
  }
  for (const record of incoming) {
    const existing = merged.get(record.id);
    if (!existing) {
      merged.set(record.id, record);
      continue;
    }
    merged.set(record.id, {
      ...existing,
      externalId: existing.externalId ?? record.externalId,
      url: existing.url ?? record.url,
      title: existing.title ?? record.title,
      status: record.status ?? existing.status,
      lastSeenAt: laterTimestamp(existing.lastSeenAt, record.lastSeenAt) ?? existing.lastSeenAt,
    });
  }
  return Array.from(merged.values()).toSorted((a, b) => a.id.localeCompare(b.id));
}

function summarizeState(
  sourceKind: TaskSourceKind,
  state: TaskResolutionState | TaskReconciliationState,
): string {
  return `${sourceKind} reported ${state}`;
}

function isBackfillSource(input: TaskCanonicalSourceInput): boolean {
  const sourceSurface = normalizeText(input.sourceSurface);
  if (sourceSurface.includes("backfill") || sourceSurface.includes("reconcile")) {
    return true;
  }
  const signalKind = normalizeText(input.signalKind);
  return signalKind.includes("backfill") || signalKind.includes("reconcile");
}

export function isTaskResolutionDone(state: TaskResolutionState | undefined): boolean {
  return state === "resolved" || state === "dismissed";
}

export function createCanonicalTaskWork(
  input: TaskCanonicalWorkInput,
  fallbackObservedAt = new Date().toISOString(),
): TaskCanonicalWorkRecord {
  const sourceKind = ensureTaskSourceKind(input.source.sourceKind);
  const backfill = isBackfillSource(input.source);
  const observedAt = trimToUndefined(input.source.observedAt) ?? fallbackObservedAt;
  const externalLinks = (input.source.externalLinks ?? []).map((entry) =>
    buildExternalLinkRecord(entry, observedAt),
  );
  const canonicalFingerprint = buildCanonicalTaskFingerprint({
    source: {
      ...input.source,
      sourceKind,
    },
  });
  const sourceFingerprint = buildSourceFingerprint({
    ...input.source,
    sourceKind,
  });
  const idempotencyKey = buildIdempotencyKey(
    {
      ...input.source,
      sourceKind,
    },
    sourceFingerprint,
  );
  const confidence = normalizeConfidence(input.source.confidence, sourceKind, observedAt);
  const resolutionState = resolveCanonicalResolutionState(input.source) ?? "open";
  const reconciliationState = resolveCanonicalReconciliationState(input.source) ?? "canonical";
  const sourceRecord: TaskSourceRecord = {
    id: buildFingerprint("source-record", [sourceKind, sourceFingerprint]),
    sourceKind,
    signalKind: trimToUndefined(input.source.signalKind),
    title: trimToUndefined(input.source.title),
    summary: trimToUndefined(input.source.summary),
    sourceFingerprint,
    idempotencyKey,
    provenance: buildSourceProvenanceRecord(
      {
        ...input.source,
        sourceKind,
      },
      observedAt,
      idempotencyKey,
    ),
    confidence,
    externalLinkIds: externalLinks.map((entry) => entry.id),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    lastResolutionState: resolutionState,
  };
  return {
    canonicalFingerprint,
    fingerprints: buildFingerprintRecords({
      canonicalFingerprint,
      sourceKind,
      sourceFingerprint,
      idempotencyKey,
      externalLinks,
      observedAt,
    }),
    externalLinks,
    sources: [sourceRecord],
    confidence,
    resolution: {
      state: resolutionState,
      summary: trimToUndefined(input.source.resolutionSummary),
      sourceKind,
      updatedAt: observedAt,
      ...(isTaskResolutionDone(resolutionState) ? { resolvedAt: observedAt } : {}),
    },
    reconciliation: {
      state: reconciliationState,
      summary:
        reconciliationState === "canonical"
          ? "canonical task created"
          : summarizeState(sourceKind, reconciliationState),
      updatedAt: observedAt,
      winnerSourceKind: sourceKind,
    },
    history: [
      buildHistoryEntry({
        action: "created",
        sourceKind,
        fingerprint: canonicalFingerprint,
        summary: backfill
          ? `created canonical task from ${sourceKind} backfill`
          : `created canonical task from ${sourceKind}`,
        createdAt: observedAt,
      }),
    ],
  };
}

function matchSourceRecord(
  sources: TaskSourceRecord[],
  incoming: TaskSourceRecord,
): TaskSourceRecord | undefined {
  return sources.find((source) => {
    if (source.idempotencyKey === incoming.idempotencyKey) {
      return true;
    }
    if (source.sourceFingerprint === incoming.sourceFingerprint) {
      return true;
    }
    return (
      source.sourceKind === incoming.sourceKind &&
      source.provenance.sourceId &&
      source.provenance.sourceId === incoming.provenance.sourceId
    );
  });
}

function mergeSourceRecord(
  current: TaskSourceRecord,
  incoming: TaskSourceRecord,
): TaskSourceRecord {
  return {
    ...current,
    signalKind: current.signalKind ?? incoming.signalKind,
    title: current.title ?? incoming.title,
    summary: current.summary ?? incoming.summary,
    confidence: preferConfidence(current.confidence, incoming.confidence),
    externalLinkIds: uniqueStrings([...current.externalLinkIds, ...incoming.externalLinkIds]),
    lastObservedAt:
      laterTimestamp(current.lastObservedAt, incoming.lastObservedAt) ?? current.lastObservedAt,
    lastResolutionState: incoming.lastResolutionState ?? current.lastResolutionState,
    provenance: {
      ...current.provenance,
      sourceSurface: current.provenance.sourceSurface ?? incoming.provenance.sourceSurface,
      sourceId: current.provenance.sourceId ?? incoming.provenance.sourceId,
      requestId: incoming.provenance.requestId ?? current.provenance.requestId,
      observedAt:
        laterTimestamp(current.provenance.observedAt, incoming.provenance.observedAt) ??
        current.provenance.observedAt,
      truthLayer: current.provenance.truthLayer || incoming.provenance.truthLayer,
      truthRank: current.provenance.truthRank ?? incoming.provenance.truthRank,
      reconciliationMode:
        current.provenance.reconciliationMode ?? incoming.provenance.reconciliationMode,
      promoteToTaskTruth:
        current.provenance.promoteToTaskTruth || incoming.provenance.promoteToTaskTruth,
    },
  };
}

function mergeConfidenceFromSources(
  current: TaskConfidenceRecord | undefined,
  sources: TaskSourceRecord[],
): TaskConfidenceRecord | undefined {
  return sources.reduce<TaskConfidenceRecord | undefined>(
    (best, source) => preferConfidence(best, source.confidence),
    current,
  );
}

export function mergeCanonicalTaskWork(
  current: TaskCanonicalWorkRecord,
  input: TaskCanonicalWorkInput,
  fallbackObservedAt = new Date().toISOString(),
): TaskCanonicalMergeResult {
  const incoming = createCanonicalTaskWork(input, fallbackObservedAt);
  const source = incoming.sources[0];
  const backfill = isBackfillSource(input.source);
  if (!source) {
    throw new Error("incoming canonical task work is missing a source");
  }
  const matchingSource = matchSourceRecord(current.sources, source);
  const action: TaskCanonicalUpsertAction = matchingSource ? "idempotent" : "merged";

  const sources = matchingSource
    ? current.sources.map((entry) =>
        entry.id === matchingSource.id ? mergeSourceRecord(entry, source) : entry,
      )
    : [...current.sources, source];
  const externalLinks = mergeExternalLinks(current.externalLinks, incoming.externalLinks);
  const fingerprints = mergeFingerprints(current.fingerprints, incoming.fingerprints);
  const confidence = mergeConfidenceFromSources(current.confidence, sources);
  const observedAt = source.lastObservedAt;
  const incomingTruthRank = source.provenance.truthRank ?? 99;
  const currentResolutionTruthRank = resolveCurrentTruthRank(
    current,
    current.resolution.sourceKind,
  );
  const currentReconciliationTruthRank = resolveCurrentTruthRank(
    current,
    current.reconciliation.winnerSourceKind,
  );
  let blockedResolutionUpdate = false;
  let blockedReconciliationUpdate = false;

  let resolution = { ...current.resolution };
  let resolutionTransition:
    | {
        from: TaskResolutionState;
        to: TaskResolutionState;
      }
    | undefined;
  const incomingResolution = resolveCanonicalResolutionState(input.source);
  if (incomingResolution && incomingResolution !== current.resolution.state) {
    if (incomingTruthRank > currentResolutionTruthRank) {
      blockedResolutionUpdate = true;
    } else {
      const nextState =
        incomingResolution === "open" && isTaskResolutionDone(current.resolution.state)
          ? "reopened"
          : incomingResolution;
      resolution = {
        state: nextState,
        summary: trimToUndefined(input.source.resolutionSummary) ?? current.resolution.summary,
        sourceKind: source.sourceKind,
        updatedAt: observedAt,
        resolvedAt: isTaskResolutionDone(nextState)
          ? (current.resolution.resolvedAt ?? observedAt)
          : current.resolution.resolvedAt,
      };
      if (nextState !== current.resolution.state) {
        resolutionTransition = {
          from: current.resolution.state,
          to: nextState,
        };
      }
    }
  }

  let reconciliation = { ...current.reconciliation };
  let reconciliationTransition:
    | {
        from: TaskReconciliationState;
        to: TaskReconciliationState;
      }
    | undefined;
  const explicitReconciliation = resolveCanonicalReconciliationState(input.source);
  const nextReconciliationState =
    explicitReconciliation ?? (sources.length > 1 ? "reconciled" : current.reconciliation.state);
  if (nextReconciliationState !== current.reconciliation.state) {
    if (incomingTruthRank > currentReconciliationTruthRank) {
      blockedReconciliationUpdate = true;
    } else {
      reconciliation = {
        state: nextReconciliationState,
        summary:
          nextReconciliationState === "reconciled"
            ? `reconciled ${sources.length} sources`
            : summarizeState(source.sourceKind, nextReconciliationState),
        updatedAt: observedAt,
        winnerSourceKind: source.sourceKind,
      };
      reconciliationTransition = {
        from: current.reconciliation.state,
        to: nextReconciliationState,
      };
    }
  }

  const history = [...current.history];
  if (matchingSource) {
    history.push(
      buildHistoryEntry({
        action: "delivery_deduped",
        sourceKind: source.sourceKind,
        fingerprint: source.idempotencyKey,
        summary: backfill
          ? `deduped backfill delivery from ${source.sourceKind}`
          : `deduped repeat delivery from ${source.sourceKind}`,
        createdAt: observedAt,
      }),
    );
  } else {
    history.push(
      buildHistoryEntry({
        action: "source_attached",
        sourceKind: source.sourceKind,
        fingerprint: source.sourceFingerprint,
        summary: backfill
          ? `attached ${source.sourceKind} backfill source to canonical task`
          : `attached ${source.sourceKind} source to canonical task`,
        createdAt: observedAt,
      }),
    );
  }
  if (resolutionTransition) {
    history.push(
      buildHistoryEntry({
        action: resolutionTransition.to === "reopened" ? "reopened" : "resolved",
        sourceKind: source.sourceKind,
        fingerprint: incoming.canonicalFingerprint,
        summary: summarizeState(source.sourceKind, resolutionTransition.to),
        createdAt: observedAt,
      }),
    );
  }
  if (reconciliationTransition) {
    history.push(
      buildHistoryEntry({
        action:
          reconciliationTransition.to === "stale"
            ? "stale_marked"
            : reconciliationTransition.to === "conflict"
              ? "conflict_recorded"
              : "reconciled",
        sourceKind: source.sourceKind,
        fingerprint: incoming.canonicalFingerprint,
        summary: summarizeState(source.sourceKind, reconciliationTransition.to),
        createdAt: observedAt,
      }),
    );
  }

  return {
    action,
    canonicalWork: {
      ...current,
      fingerprints,
      externalLinks,
      sources,
      confidence,
      resolution,
      reconciliation,
      history,
    },
    resolutionTransition,
    reconciliationTransition,
    truthGate: {
      blockedResolutionUpdate,
      blockedReconciliationUpdate,
    },
  };
}
