/** Shared channel-ingress observability contract types and constants. */

export const CHANNEL_INGRESS_OBSERVABILITY_METADATA_KEY = "ingressProgress";
export const CHANNEL_INGRESS_OBSERVABILITY_OWNER = "openclaw.channel-ingress";
export const CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION = 1;

export const CHANNEL_INGRESS_PREPARATION_STAGES = [
  "queued",
  "routing",
  "dedupe_wait",
  "user_channel_lookup",
  "thread_history",
  "media_preparation",
  "adoption",
  "execution",
  "delivery",
  "settlement",
] as const;

export type ChannelIngressPreparationStage = (typeof CHANNEL_INGRESS_PREPARATION_STAGES)[number];

export const CHANNEL_INGRESS_BLOCKERS = [
  "none",
  "slack_api",
  "rate_limit_sleep",
  "dedupe_owner",
  "previous_turn",
  "channel_migration",
  "approval",
  "model",
  "state_store",
  "unknown",
] as const;

export type ChannelIngressBlocker = (typeof CHANNEL_INGRESS_BLOCKERS)[number];

export const CHANNEL_INGRESS_OPERATION_KINDS = ["api", "dedupe", "sleep"] as const;

export type ChannelIngressOperationKind = (typeof CHANNEL_INGRESS_OPERATION_KINDS)[number];

export type ChannelIngressOperationOutcome = "completed" | "failed" | "cancelled" | "unknown";

export type ChannelIngressCorrelation = {
  providerEventType?: string;
  teamId?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  sessionId?: string;
  runId?: string;
};

type ChannelIngressOperationBegin = {
  phase: "begin";
  kind: ChannelIngressOperationKind;
  id?: string;
  method?: string;
  profile?: string;
  startedAt?: number;
};

type ChannelIngressOperationFinish = {
  phase: "finish";
  id: string;
  finishedAt?: number;
  outcome?: ChannelIngressOperationOutcome;
};

type ChannelIngressOperationRequest = {
  kind: ChannelIngressOperationKind;
  method?: string;
  profile?: string;
};

export type ChannelIngressProgressUpdate = {
  stage?: ChannelIngressPreparationStage;
  blocker?: ChannelIngressBlocker;
  stageStartedAt?: number;
  progressAt?: number;
  observedAt?: number;
  operation?: ChannelIngressOperationBegin | ChannelIngressOperationFinish;
  correlation?: ChannelIngressCorrelation;
};

export type ChannelIngressOperationSnapshot = {
  id: string;
  kind: ChannelIngressOperationKind;
  startedAt: number;
  method?: string;
  profile?: string;
};

export type ChannelIngressHistoricalOperationSnapshot = ChannelIngressOperationSnapshot & {
  historical: true;
  outcome?: ChannelIngressOperationOutcome;
  finishedAt?: number;
};

export type ChannelIngressProgressMetadataV1 = {
  owner: typeof CHANNEL_INGRESS_OBSERVABILITY_OWNER;
  schemaVersion: typeof CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION;
  stage: ChannelIngressPreparationStage;
  blocker: ChannelIngressBlocker;
  stageStartedAt: number;
  lastProgressAt?: number;
  updatedAt: number;
  activeOperations?: ChannelIngressOperationSnapshot[];
  lastOperation?: ChannelIngressHistoricalOperationSnapshot;
  lastPreparation?: {
    stage: ChannelIngressPreparationStage;
    blocker: ChannelIngressBlocker;
    stageStartedAt: number;
    completedAt: number;
    elapsedMs: number;
  };
  correlation?: ChannelIngressCorrelation;
  terminal?: {
    disposition: "completed" | "failed";
    recordedAt: number;
  };
};

export type ChannelIngressSnapshotEvent = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  status: "pending" | "claimed";
  receivedAt: number;
  receiptAgeMs: number;
  stage: ChannelIngressPreparationStage | "unknown";
  blocker: ChannelIngressBlocker;
  progressKnown: boolean;
  updatedAt: number;
  stageStartedAt?: number;
  stageAgeMs?: number;
  lastProgressAt?: number;
  noProgressAgeMs?: number;
  claimedAt?: number;
  claimedAgeMs?: number;
  correlation?: ChannelIngressCorrelation;
  lastOperation?: ChannelIngressHistoricalOperationSnapshot;
};

export type ChannelIngressBlockerSnapshot = {
  blocker: ChannelIngressBlocker;
  total: number;
  pending: number;
  claimed: number;
  oldestReceiptAgeMs?: number;
};

export type ChannelIngressStageSnapshot = {
  stage: ChannelIngressPreparationStage;
  total: number;
  pending: number;
  claimed: number;
  unknownProgress: number;
  oldestReceiptAgeMs?: number;
  eligibleNoProgressCount: number;
  maxEligibleNoProgressAgeMs?: number;
  blockers: Record<ChannelIngressBlocker, ChannelIngressBlockerSnapshot>;
  oldest?: ChannelIngressSnapshotEvent;
};

export type ChannelIngressUnknownProgressSnapshot = Omit<ChannelIngressStageSnapshot, "stage"> & {
  stage: "unknown";
};

export type ChannelIngressObservationRecordRef = {
  eventId: string;
  queueName?: string;
  channelId?: string;
  accountId?: string;
};

export type ChannelIngressActiveOperationSnapshot = ChannelIngressOperationSnapshot &
  Partial<ChannelIngressObservationRecordRef>;

type ChannelIngressOldestOperationSnapshot = ChannelIngressActiveOperationSnapshot & {
  ageMs: number;
};

export type ChannelIngressOperationAggregate = {
  kind: ChannelIngressOperationKind;
  total: number;
  known: boolean;
  truncated: boolean;
  overflowCount: number;
  oldestAgeMs?: number;
  oldest?: ChannelIngressOldestOperationSnapshot;
};

export type ChannelIngressActiveOperationsSnapshot = {
  operations: readonly ChannelIngressActiveOperationSnapshot[];
  overflowByKind?: Partial<Record<ChannelIngressOperationKind, number>>;
  unknownProgressEvents?: readonly ChannelIngressObservationRecordRef[];
};

export type ChannelIngressObservabilitySnapshot = {
  type: "ingress.snapshot";
  schemaVersion: typeof CHANNEL_INGRESS_OBSERVABILITY_SCHEMA_VERSION;
  sampledAt: number;
  status: "known" | "unknown";
  isolationAvailable: false;
  failedCount: number;
  stages: Record<ChannelIngressPreparationStage, ChannelIngressStageSnapshot>;
  unknown: ChannelIngressUnknownProgressSnapshot;
  operations: Record<ChannelIngressOperationKind, ChannelIngressOperationAggregate>;
};

export type ChannelIngressObservabilityRow = {
  event_id: string;
  channel_id: string;
  account_id: string;
  queue_name: string;
  status: string;
  metadata_json: string | null;
  received_at: number;
  updated_at: number;
  claimed_at: number | null;
  failed_at?: number | null;
};

export type ChannelIngressLifecycleObserver = {
  stage: (stage: ChannelIngressPreparationStage, blocker?: ChannelIngressBlocker) => void;
  progress: (stage?: ChannelIngressPreparationStage, blocker?: ChannelIngressBlocker) => void;
  correlate: (correlation: ChannelIngressCorrelation) => void;
  begin: (operation: ChannelIngressOperationRequest) => {
    finish: (outcome?: ChannelIngressOperationOutcome) => void;
  };
};

export type ChannelIngressObserverController = ChannelIngressLifecycleObserver & {
  getActiveOperations: () => ChannelIngressActiveOperationSnapshot[];
  getActiveOperationSnapshot: () => ChannelIngressActiveOperationsSnapshot;
  revoke: () => void;
};
