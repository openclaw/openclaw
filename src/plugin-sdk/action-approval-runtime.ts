import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { ChannelThreadingToolContext } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MessageActionRunResult,
  RunMessageActionParams,
} from "../infra/outbound/message-action-runner.js";
import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
} from "../plugins/runtime/runtime-taskflow.types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { JsonValue, TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskNotifyPolicy } from "../tasks/task-registry.types.js";

export const ACTION_APPROVAL_SCHEMA_VERSION = 1;
export const ACTION_APPROVAL_INTERACTIVE_DATA_KEY = "openclawInteractive";
export const ACTION_APPROVAL_DECISIONS = ["approve", "deny", "revise"] as const;

export type ActionApprovalDecision = (typeof ACTION_APPROVAL_DECISIONS)[number];
export type ActionApprovalOutcomeStatus =
  | "pending"
  | "claimed"
  | "succeeded"
  | "failed"
  | "expired"
  | "denied"
  | "revised";

export type ActionApprovalFact = {
  title: string;
  value: string;
};

export type ActionApprovalActionMetadata = {
  kind: string;
  title: string;
  summary?: string;
  highRisk?: boolean;
  facts?: ActionApprovalFact[];
  metadata?: Record<string, JsonValue>;
};

export type ActionApprovalFlowState<TSnapshot extends JsonValue = JsonValue> = {
  kind: "action_approval";
  version: typeof ACTION_APPROVAL_SCHEMA_VERSION;
  ownerSessionKey: string;
  action: ActionApprovalActionMetadata;
  snapshot: TSnapshot;
  snapshotHash: string;
  createdAt: number;
  expiresAt?: number;
  status: ActionApprovalOutcomeStatus;
  decision?: ActionApprovalDecision;
  actedAt?: number;
  actorId?: string;
  result?: JsonValue;
};

export type ActionApprovalWaitState = {
  kind: "action_approval_wait";
  version: typeof ACTION_APPROVAL_SCHEMA_VERSION;
  ownerSessionKey: string;
  action: ActionApprovalActionMetadata;
  snapshotHash: string;
  createdAt: number;
  expiresAt?: number;
  decisions: ActionApprovalDecision[];
};

export type ActionApprovalInteractivePayload = {
  version: typeof ACTION_APPROVAL_SCHEMA_VERSION;
  ownerSessionKey: string;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  decision: ActionApprovalDecision;
  action: Pick<ActionApprovalActionMetadata, "kind" | "title" | "highRisk">;
};

export type ActionApprovalReadErrorCode =
  | "not_found"
  | "not_managed"
  | "revision_conflict"
  | "invalid_state"
  | "snapshot_hash_mismatch"
  | "unexpected_status";

export type ActionApprovalReadResult<TSnapshot extends JsonValue = JsonValue> =
  | {
      ok: true;
      flow: ManagedTaskFlowRecord;
      state: ActionApprovalFlowState<TSnapshot>;
      wait: ActionApprovalWaitState | null;
      snapshot: TSnapshot;
      snapshotHash: string;
    }
  | {
      ok: false;
      code: ActionApprovalReadErrorCode;
      current?: TaskFlowRecord;
    };

export type ActionApprovalMutationResult<TSnapshot extends JsonValue = JsonValue> =
  | {
      applied: true;
      flow: ManagedTaskFlowRecord;
      state: ActionApprovalFlowState<TSnapshot>;
      wait: ActionApprovalWaitState | null;
      snapshot: TSnapshot;
      snapshotHash: string;
    }
  | {
      applied: false;
      code: ActionApprovalReadErrorCode | "expired";
      current?: TaskFlowRecord;
    };

type RunMessageActionFn = (input: RunMessageActionParams) => Promise<MessageActionRunResult>;

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActionApprovalDecision(value: string): value is ActionApprovalDecision {
  return ACTION_APPROVAL_DECISIONS.includes(value as ActionApprovalDecision);
}

function isActionApprovalOutcomeStatus(value: string): value is ActionApprovalOutcomeStatus {
  return (
    value === "pending" ||
    value === "claimed" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "expired" ||
    value === "denied" ||
    value === "revised"
  );
}

function normalizeActionFacts(value: unknown): ActionApprovalFact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const facts = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const fact = entry as { title?: unknown; value?: unknown };
      const title = normalizeOptionalString(fact.title);
      const resolvedValue = normalizeOptionalString(fact.value);
      if (!title || !resolvedValue) {
        return null;
      }
      return { title, value: resolvedValue };
    })
    .filter((entry): entry is ActionApprovalFact => Boolean(entry));
  return facts.length > 0 ? facts : undefined;
}

function normalizeActionMetadata(value: unknown): ActionApprovalActionMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as {
    kind?: unknown;
    title?: unknown;
    summary?: unknown;
    highRisk?: unknown;
    facts?: unknown;
    metadata?: unknown;
  };
  const kind = normalizeOptionalString(record.kind);
  const title = normalizeOptionalString(record.title);
  if (!kind || !title) {
    return null;
  }
  const summary = normalizeOptionalString(record.summary);
  const facts = normalizeActionFacts(record.facts);
  return {
    kind,
    title,
    ...(summary ? { summary } : {}),
    ...(record.highRisk === true ? { highRisk: true } : {}),
    ...(facts ? { facts } : {}),
    ...(isJsonRecord(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

function normalizeState<TSnapshot extends JsonValue = JsonValue>(
  value: unknown,
): ActionApprovalFlowState<TSnapshot> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as {
    kind?: unknown;
    version?: unknown;
    ownerSessionKey?: unknown;
    action?: unknown;
    snapshot?: unknown;
    snapshotHash?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
    status?: unknown;
    decision?: unknown;
    actedAt?: unknown;
    actorId?: unknown;
    result?: unknown;
  };
  if (
    record.kind !== "action_approval" ||
    record.version !== ACTION_APPROVAL_SCHEMA_VERSION ||
    !normalizeOptionalString(record.ownerSessionKey) ||
    typeof record.createdAt !== "number" ||
    !normalizeOptionalString(record.snapshotHash)
  ) {
    return null;
  }
  const action = normalizeActionMetadata(record.action);
  const status = normalizeOptionalString(record.status);
  if (!action || !status || !isActionApprovalOutcomeStatus(status)) {
    return null;
  }
  const decision = normalizeOptionalLowercaseString(record.decision);
  const actorId = normalizeOptionalString(record.actorId);
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  const actedAt = typeof record.actedAt === "number" ? record.actedAt : undefined;
  return {
    kind: "action_approval",
    version: ACTION_APPROVAL_SCHEMA_VERSION,
    ownerSessionKey: record.ownerSessionKey as string,
    action,
    snapshot: record.snapshot as TSnapshot,
    snapshotHash: record.snapshotHash as string,
    createdAt: record.createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    status,
    ...(decision && isActionApprovalDecision(decision) ? { decision } : {}),
    ...(actedAt !== undefined ? { actedAt } : {}),
    ...(actorId ? { actorId } : {}),
    ...(record.result !== undefined ? { result: record.result as JsonValue } : {}),
  };
}

function normalizeWaitState(value: unknown): ActionApprovalWaitState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as {
    kind?: unknown;
    version?: unknown;
    ownerSessionKey?: unknown;
    action?: unknown;
    snapshotHash?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
    decisions?: unknown;
  };
  if (
    record.kind !== "action_approval_wait" ||
    record.version !== ACTION_APPROVAL_SCHEMA_VERSION ||
    !normalizeOptionalString(record.ownerSessionKey) ||
    typeof record.createdAt !== "number" ||
    !normalizeOptionalString(record.snapshotHash)
  ) {
    return null;
  }
  const action = normalizeActionMetadata(record.action);
  if (!action) {
    return null;
  }
  const decisions = Array.isArray(record.decisions)
    ? record.decisions
        .map((entry) => normalizeOptionalLowercaseString(entry))
        .filter((entry): entry is ActionApprovalDecision =>
          Boolean(entry && isActionApprovalDecision(entry)),
        )
    : [];
  if (decisions.length !== ACTION_APPROVAL_DECISIONS.length) {
    return null;
  }
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  return {
    kind: "action_approval_wait",
    version: ACTION_APPROVAL_SCHEMA_VERSION,
    ownerSessionKey: record.ownerSessionKey as string,
    action,
    snapshotHash: record.snapshotHash as string,
    createdAt: record.createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    decisions,
  };
}

function buildActionApprovalState<TSnapshot extends JsonValue>(params: {
  ownerSessionKey: string;
  action: ActionApprovalActionMetadata;
  snapshot: TSnapshot;
  snapshotHash: string;
  createdAt: number;
  expiresAt?: number;
  status?: ActionApprovalOutcomeStatus;
  decision?: ActionApprovalDecision;
  actedAt?: number;
  actorId?: string;
  result?: JsonValue;
}): ActionApprovalFlowState<TSnapshot> {
  return {
    kind: "action_approval",
    version: ACTION_APPROVAL_SCHEMA_VERSION,
    ownerSessionKey: params.ownerSessionKey,
    action: params.action,
    snapshot: params.snapshot,
    snapshotHash: params.snapshotHash,
    createdAt: params.createdAt,
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    status: params.status ?? "pending",
    ...(params.decision ? { decision: params.decision } : {}),
    ...(params.actedAt !== undefined ? { actedAt: params.actedAt } : {}),
    ...(params.actorId ? { actorId: params.actorId } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
  };
}

function buildActionApprovalWaitState(params: {
  ownerSessionKey: string;
  action: ActionApprovalActionMetadata;
  snapshotHash: string;
  createdAt: number;
  expiresAt?: number;
}): ActionApprovalWaitState {
  return {
    kind: "action_approval_wait",
    version: ACTION_APPROVAL_SCHEMA_VERSION,
    ownerSessionKey: params.ownerSessionKey,
    action: params.action,
    snapshotHash: params.snapshotHash,
    createdAt: params.createdAt,
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    decisions: [...ACTION_APPROVAL_DECISIONS],
  };
}

function assertActionApprovalActionMetadata(
  action: ActionApprovalActionMetadata,
): ActionApprovalActionMetadata {
  const kind = normalizeOptionalString(action.kind);
  const title = normalizeOptionalString(action.title);
  if (!kind || !title) {
    throw new Error("Action approval metadata requires action.kind and action.title.");
  }
  return {
    kind,
    title,
    ...(normalizeOptionalString(action.summary)
      ? { summary: normalizeOptionalString(action.summary)! }
      : {}),
    ...(action.highRisk === true ? { highRisk: true } : {}),
    ...(Array.isArray(action.facts) && action.facts.length > 0 ? { facts: action.facts } : {}),
    ...(action.metadata ? { metadata: action.metadata } : {}),
  };
}

function asManagedFlow(flow: TaskFlowRecord | undefined): ManagedTaskFlowRecord | undefined {
  return flow && flow.syncMode === "managed" && flow.controllerId
    ? (flow as ManagedTaskFlowRecord)
    : undefined;
}

function mapMutationFailure(
  result: ManagedTaskFlowMutationResult,
): Extract<ActionApprovalMutationResult, { applied: false }> {
  if (result.applied) {
    throw new Error("Expected a failed managed task-flow mutation.");
  }
  return {
    applied: false,
    code: result.code,
    ...(result.current ? { current: result.current } : {}),
  };
}

function resolveReadFailure(code: ActionApprovalReadErrorCode, current?: TaskFlowRecord) {
  return {
    ok: false as const,
    code,
    ...(current ? { current } : {}),
  };
}

function resolveLoadedActionApproval<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
}): ActionApprovalReadResult<TSnapshot> {
  const current = params.taskFlow.get(params.flowId);
  if (!current) {
    return resolveReadFailure("not_found");
  }
  const flow = asManagedFlow(current);
  if (!flow) {
    return resolveReadFailure("not_managed", current);
  }
  if (flow.revision !== params.expectedRevision) {
    return resolveReadFailure("revision_conflict", flow);
  }
  const state = normalizeState<TSnapshot>(flow.stateJson);
  if (!state) {
    return resolveReadFailure("invalid_state", flow);
  }
  if (state.snapshotHash !== params.snapshotHash) {
    return resolveReadFailure("snapshot_hash_mismatch", flow);
  }
  const wait = flow.waitJson == null ? null : normalizeWaitState(flow.waitJson);
  if (flow.waitJson != null && !wait) {
    return resolveReadFailure("invalid_state", flow);
  }
  return {
    ok: true,
    flow,
    state,
    wait,
    snapshot: state.snapshot,
    snapshotHash: state.snapshotHash,
  };
}

function resolveCardActionMetadata(
  action: ActionApprovalActionMetadata,
): ActionApprovalInteractivePayload["action"] {
  return {
    kind: action.kind,
    title: action.title,
    ...(action.highRisk ? { highRisk: true } : {}),
  };
}

function buildActionApprovalSubmitData(params: {
  namespace: string;
  decision: ActionApprovalDecision;
  ownerSessionKey: string;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  action: ActionApprovalActionMetadata;
}) {
  return {
    [ACTION_APPROVAL_INTERACTIVE_DATA_KEY]: buildActionApprovalInteractiveData({
      namespace: params.namespace,
      payload: {
        version: ACTION_APPROVAL_SCHEMA_VERSION,
        ownerSessionKey: params.ownerSessionKey,
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        snapshotHash: params.snapshotHash,
        decision: params.decision,
        action: resolveCardActionMetadata(params.action),
      },
    }),
  };
}

export function hashActionApprovalSnapshot(snapshot: JsonValue): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

export function createWaitingActionApprovalFlow<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  controllerId: string;
  goal: string;
  action: ActionApprovalActionMetadata;
  snapshot: TSnapshot;
  currentStep?: string | null;
  waitingStep?: string | null;
  notifyPolicy?: TaskNotifyPolicy;
  createdAt?: number;
  expiresAt?: number | null;
}): {
  flow: ManagedTaskFlowRecord;
  state: ActionApprovalFlowState<TSnapshot>;
  wait: ActionApprovalWaitState;
  snapshotHash: string;
  expectedRevision: number;
} {
  const ownerSessionKey = normalizeOptionalString(params.taskFlow.sessionKey);
  if (!ownerSessionKey) {
    throw new Error("Action approval flow requires a bound task-flow session key.");
  }
  const createdAt = params.createdAt ?? Date.now();
  const expiresAt = typeof params.expiresAt === "number" ? params.expiresAt : undefined;
  const action = assertActionApprovalActionMetadata(params.action);
  const snapshotHash = hashActionApprovalSnapshot(params.snapshot);
  const state = buildActionApprovalState({
    ownerSessionKey,
    action,
    snapshot: params.snapshot,
    snapshotHash,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  const wait = buildActionApprovalWaitState({
    ownerSessionKey,
    action,
    snapshotHash,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  const created = params.taskFlow.createManaged({
    controllerId: params.controllerId,
    goal: params.goal,
    currentStep: params.currentStep,
    status: "running",
    notifyPolicy: params.notifyPolicy,
    stateJson: state,
    createdAt,
    updatedAt: createdAt,
  });
  const waiting = params.taskFlow.setWaiting({
    flowId: created.flowId,
    expectedRevision: created.revision,
    currentStep: params.waitingStep ?? params.currentStep ?? null,
    stateJson: state,
    waitJson: wait,
    updatedAt: createdAt,
  });
  if (!waiting.applied) {
    throw new Error(`Failed to create waiting action approval flow: ${waiting.code}`);
  }
  return {
    flow: waiting.flow,
    state,
    wait,
    snapshotHash,
    expectedRevision: waiting.flow.revision,
  };
}

export function loadActionApprovalFlow<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
}): ActionApprovalReadResult<TSnapshot> {
  return resolveLoadedActionApproval(params);
}

export function claimActionApprovalFlow<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  actorId?: string | null;
  now?: number;
}): ActionApprovalMutationResult<TSnapshot> {
  const loaded = resolveLoadedActionApproval<TSnapshot>(params);
  if (!loaded.ok) {
    return {
      applied: false,
      code: loaded.code,
      ...(loaded.current ? { current: loaded.current } : {}),
    };
  }
  if (loaded.flow.status !== "waiting" || loaded.state.status !== "pending") {
    return {
      applied: false,
      code: "unexpected_status",
      current: loaded.flow,
    };
  }
  const now = params.now ?? Date.now();
  const actorId = normalizeOptionalString(params.actorId);
  if (loaded.state.expiresAt !== undefined && now >= loaded.state.expiresAt) {
    const expiredState = buildActionApprovalState({
      ownerSessionKey: loaded.state.ownerSessionKey,
      action: loaded.state.action,
      snapshot: loaded.snapshot,
      snapshotHash: loaded.snapshotHash,
      createdAt: loaded.state.createdAt,
      ...(loaded.state.expiresAt !== undefined ? { expiresAt: loaded.state.expiresAt } : {}),
      status: "expired",
      decision: "deny",
      actedAt: now,
      ...(actorId ? { actorId } : {}),
    });
    const failed = params.taskFlow.fail({
      flowId: loaded.flow.flowId,
      expectedRevision: loaded.flow.revision,
      stateJson: expiredState,
      blockedSummary: "Approval timed out.",
      updatedAt: now,
      endedAt: now,
    });
    if (!failed.applied) {
      return mapMutationFailure(failed);
    }
    return {
      applied: false,
      code: "expired",
      current: failed.flow,
    };
  }
  const claimedState = buildActionApprovalState({
    ownerSessionKey: loaded.state.ownerSessionKey,
    action: loaded.state.action,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
    createdAt: loaded.state.createdAt,
    ...(loaded.state.expiresAt !== undefined ? { expiresAt: loaded.state.expiresAt } : {}),
    status: "claimed",
    decision: "approve",
    actedAt: now,
    ...(actorId ? { actorId } : {}),
  });
  const resumed = params.taskFlow.resume({
    flowId: loaded.flow.flowId,
    expectedRevision: loaded.flow.revision,
    status: "running",
    stateJson: claimedState,
    updatedAt: now,
  });
  if (!resumed.applied) {
    return mapMutationFailure(resumed);
  }
  return {
    applied: true,
    flow: resumed.flow,
    state: claimedState,
    wait: loaded.wait,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
  };
}

export function resolveActionApprovalDecision<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  decision: Extract<ActionApprovalDecision, "deny" | "revise">;
  actorId?: string | null;
  now?: number;
  blockedSummary?: string;
  result?: JsonValue;
}): ActionApprovalMutationResult<TSnapshot> {
  const loaded = resolveLoadedActionApproval<TSnapshot>(params);
  if (!loaded.ok) {
    return {
      applied: false,
      code: loaded.code,
      ...(loaded.current ? { current: loaded.current } : {}),
    };
  }
  if (loaded.flow.status !== "waiting" || loaded.state.status !== "pending") {
    return {
      applied: false,
      code: "unexpected_status",
      current: loaded.flow,
    };
  }
  const now = params.now ?? Date.now();
  const actorId = normalizeOptionalString(params.actorId);
  const deniedState = buildActionApprovalState({
    ownerSessionKey: loaded.state.ownerSessionKey,
    action: loaded.state.action,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
    createdAt: loaded.state.createdAt,
    ...(loaded.state.expiresAt !== undefined ? { expiresAt: loaded.state.expiresAt } : {}),
    status: params.decision === "deny" ? "denied" : "revised",
    decision: params.decision,
    actedAt: now,
    ...(actorId ? { actorId } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
  });
  const failed = params.taskFlow.fail({
    flowId: loaded.flow.flowId,
    expectedRevision: loaded.flow.revision,
    stateJson: deniedState,
    blockedSummary:
      params.blockedSummary ??
      (params.decision === "deny" ? "Approval denied." : "Revision requested."),
    updatedAt: now,
    endedAt: now,
  });
  if (!failed.applied) {
    return mapMutationFailure(failed);
  }
  return {
    applied: true,
    flow: failed.flow,
    state: deniedState,
    wait: loaded.wait,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
  };
}

export function finishClaimedActionApprovalFlow<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  now?: number;
  actorId?: string | null;
  result?: JsonValue;
}): ActionApprovalMutationResult<TSnapshot> {
  const loaded = resolveLoadedActionApproval<TSnapshot>(params);
  if (!loaded.ok) {
    return {
      applied: false,
      code: loaded.code,
      ...(loaded.current ? { current: loaded.current } : {}),
    };
  }
  if (loaded.flow.status !== "running" || loaded.state.status !== "claimed") {
    return {
      applied: false,
      code: "unexpected_status",
      current: loaded.flow,
    };
  }
  const now = params.now ?? Date.now();
  const actorId = normalizeOptionalString(params.actorId) ?? loaded.state.actorId;
  const finishedState = buildActionApprovalState({
    ownerSessionKey: loaded.state.ownerSessionKey,
    action: loaded.state.action,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
    createdAt: loaded.state.createdAt,
    ...(loaded.state.expiresAt !== undefined ? { expiresAt: loaded.state.expiresAt } : {}),
    status: "succeeded",
    decision: "approve",
    actedAt: now,
    ...(actorId ? { actorId } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
  });
  const finished = params.taskFlow.finish({
    flowId: loaded.flow.flowId,
    expectedRevision: loaded.flow.revision,
    stateJson: finishedState,
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    return mapMutationFailure(finished);
  }
  return {
    applied: true,
    flow: finished.flow,
    state: finishedState,
    wait: loaded.wait,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
  };
}

export function failClaimedActionApprovalFlow<TSnapshot extends JsonValue>(params: {
  taskFlow: BoundTaskFlowRuntime;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  now?: number;
  actorId?: string | null;
  blockedSummary: string;
  status?: Extract<ActionApprovalOutcomeStatus, "failed" | "expired">;
  result?: JsonValue;
}): ActionApprovalMutationResult<TSnapshot> {
  const loaded = resolveLoadedActionApproval<TSnapshot>(params);
  if (!loaded.ok) {
    return {
      applied: false,
      code: loaded.code,
      ...(loaded.current ? { current: loaded.current } : {}),
    };
  }
  if (loaded.flow.status !== "running" || loaded.state.status !== "claimed") {
    return {
      applied: false,
      code: "unexpected_status",
      current: loaded.flow,
    };
  }
  const now = params.now ?? Date.now();
  const actorId = normalizeOptionalString(params.actorId) ?? loaded.state.actorId;
  const failedState = buildActionApprovalState({
    ownerSessionKey: loaded.state.ownerSessionKey,
    action: loaded.state.action,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
    createdAt: loaded.state.createdAt,
    ...(loaded.state.expiresAt !== undefined ? { expiresAt: loaded.state.expiresAt } : {}),
    status: params.status ?? "failed",
    decision: "approve",
    actedAt: now,
    ...(actorId ? { actorId } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
  });
  const failed = params.taskFlow.fail({
    flowId: loaded.flow.flowId,
    expectedRevision: loaded.flow.revision,
    stateJson: failedState,
    blockedSummary: params.blockedSummary,
    updatedAt: now,
    endedAt: now,
  });
  if (!failed.applied) {
    return mapMutationFailure(failed);
  }
  return {
    applied: true,
    flow: failed.flow,
    state: failedState,
    wait: loaded.wait,
    snapshot: loaded.snapshot,
    snapshotHash: loaded.snapshotHash,
  };
}

export function encodeActionApprovalInteractivePayload(
  payload: ActionApprovalInteractivePayload,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeActionApprovalInteractivePayload(
  payload: string,
): ActionApprovalInteractivePayload | null {
  const trimmed = payload.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as {
      version?: unknown;
      ownerSessionKey?: unknown;
      flowId?: unknown;
      expectedRevision?: unknown;
      snapshotHash?: unknown;
      decision?: unknown;
      action?: unknown;
    };
    const ownerSessionKey = normalizeOptionalString(parsed.ownerSessionKey);
    const flowId = normalizeOptionalString(parsed.flowId);
    const snapshotHash = normalizeOptionalString(parsed.snapshotHash);
    const decision = normalizeOptionalLowercaseString(parsed.decision);
    const action = normalizeActionMetadata(parsed.action);
    if (
      parsed.version !== ACTION_APPROVAL_SCHEMA_VERSION ||
      !ownerSessionKey ||
      !flowId ||
      typeof parsed.expectedRevision !== "number" ||
      !snapshotHash ||
      !decision ||
      !isActionApprovalDecision(decision) ||
      !action
    ) {
      return null;
    }
    return {
      version: ACTION_APPROVAL_SCHEMA_VERSION,
      ownerSessionKey,
      flowId,
      expectedRevision: parsed.expectedRevision,
      snapshotHash,
      decision,
      action: resolveCardActionMetadata(action),
    };
  } catch {
    return null;
  }
}

export function buildActionApprovalInteractiveData(params: {
  namespace: string;
  payload: ActionApprovalInteractivePayload;
}): string {
  const namespace = normalizeOptionalString(params.namespace);
  if (!namespace) {
    throw new Error("Action approval interactive namespace is required.");
  }
  return `${namespace}:${encodeActionApprovalInteractivePayload(params.payload)}`;
}

export function buildTeamsActionApprovalCard(params: {
  namespace: string;
  ownerSessionKey: string;
  flowId: string;
  expectedRevision: number;
  snapshotHash: string;
  action: ActionApprovalActionMetadata;
  body?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const action = assertActionApprovalActionMetadata(params.action);
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: action.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
  ];
  if (action.summary) {
    body.push({
      type: "TextBlock",
      text: action.summary,
      wrap: true,
      spacing: "Small",
    });
  }
  if (action.highRisk) {
    body.push({
      type: "Container",
      style: "attention",
      items: [
        {
          type: "TextBlock",
          text: "High-risk action",
          weight: "Bolder",
          wrap: true,
        },
      ],
    });
  }
  if (action.facts && action.facts.length > 0) {
    body.push({
      type: "FactSet",
      facts: action.facts.map((fact) => ({
        title: fact.title,
        value: fact.value,
      })),
    });
  }
  if (Array.isArray(params.body) && params.body.length > 0) {
    body.push(...params.body);
  }
  return {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Approve",
        style: "positive",
        data: buildActionApprovalSubmitData({
          namespace: params.namespace,
          decision: "approve",
          ownerSessionKey: params.ownerSessionKey,
          flowId: params.flowId,
          expectedRevision: params.expectedRevision,
          snapshotHash: params.snapshotHash,
          action,
        }),
      },
      {
        type: "Action.Submit",
        title: "Revise",
        data: buildActionApprovalSubmitData({
          namespace: params.namespace,
          decision: "revise",
          ownerSessionKey: params.ownerSessionKey,
          flowId: params.flowId,
          expectedRevision: params.expectedRevision,
          snapshotHash: params.snapshotHash,
          action,
        }),
      },
      {
        type: "Action.Submit",
        title: "Deny",
        style: "destructive",
        data: buildActionApprovalSubmitData({
          namespace: params.namespace,
          decision: "deny",
          ownerSessionKey: params.ownerSessionKey,
          flowId: params.flowId,
          expectedRevision: params.expectedRevision,
          snapshotHash: params.snapshotHash,
          action,
        }),
      },
    ],
  };
}

export async function deliverTeamsActionApprovalCard(params: {
  cfg: OpenClawConfig;
  to: string;
  card: Record<string, unknown>;
  accountId?: string | null;
  requesterSenderId?: string | null;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  toolContext?: ChannelThreadingToolContext;
  dryRun?: boolean;
  runMessageAction?: RunMessageActionFn;
}): Promise<MessageActionRunResult> {
  const runMessageAction =
    params.runMessageAction ??
    (await import("../infra/outbound/message-action-runner.js")).runMessageAction;
  const actionParams: Record<string, unknown> = {
    channel: "msteams",
    to: params.to,
    card: params.card,
  };
  const accountId = normalizeOptionalString(params.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }
  return await runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: actionParams,
    requesterSenderId: params.requesterSenderId ?? undefined,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    toolContext: params.toolContext,
    dryRun: params.dryRun,
  });
}
