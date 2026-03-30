import crypto from "node:crypto";
import { getFlowRegistryStore, resetFlowRegistryRuntimeForTests } from "./flow-registry.store.js";
import type { FlowRecord, FlowStatus } from "./flow-registry.types.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

const flows = new Map<string, FlowRecord>();
let restoreAttempted = false;

function cloneFlowRecord(record: FlowRecord): FlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin ? { requesterOrigin: { ...record.requesterOrigin } } : {}),
  };
}

function snapshotFlowRecords(source: ReadonlyMap<string, FlowRecord>): FlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function ensureFlowRegistryReady() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  const restored = getFlowRegistryStore().loadSnapshot();
  flows.clear();
  for (const [flowId, flow] of restored.flows) {
    flows.set(flowId, cloneFlowRecord(flow));
  }
}

function persistFlowRegistry() {
  getFlowRegistryStore().saveSnapshot({
    flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])),
  });
}

function persistFlowUpsert(flow: FlowRecord) {
  const store = getFlowRegistryStore();
  if (store.upsertFlow) {
    store.upsertFlow(cloneFlowRecord(flow));
    return;
  }
  persistFlowRegistry();
}

function persistFlowDelete(flowId: string) {
  const store = getFlowRegistryStore();
  if (store.deleteFlow) {
    store.deleteFlow(flowId);
    return;
  }
  persistFlowRegistry();
}

export function createFlowRecord(params: {
  ownerSessionKey: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  status?: FlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number;
}): FlowRecord {
  ensureFlowRegistryReady();
  const now = params.createdAt ?? Date.now();
  const record: FlowRecord = {
    flowId: crypto.randomUUID(),
    ownerSessionKey: params.ownerSessionKey,
    ...(params.requesterOrigin ? { requesterOrigin: { ...params.requesterOrigin } } : {}),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: params.currentStep?.trim() || undefined,
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
  };
  flows.set(record.flowId, record);
  persistFlowUpsert(record);
  return cloneFlowRecord(record);
}

export function updateFlowRecordById(
  flowId: string,
  patch: Partial<
    Pick<FlowRecord, "status" | "notifyPolicy" | "goal" | "currentStep" | "updatedAt" | "endedAt">
  >,
): FlowRecord | null {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return null;
  }
  const next: FlowRecord = {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    currentStep:
      patch.currentStep === undefined ? current.currentStep : patch.currentStep.trim() || undefined,
    updatedAt: patch.updatedAt ?? Date.now(),
    ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
  };
  flows.set(flowId, next);
  persistFlowUpsert(next);
  return cloneFlowRecord(next);
}

export function getFlowById(flowId: string): FlowRecord | undefined {
  ensureFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listFlowRecords(): FlowRecord[] {
  ensureFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => left.createdAt - right.createdAt);
}

export function deleteFlowRecordById(flowId: string): boolean {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  flows.delete(flowId);
  persistFlowDelete(flowId);
  return true;
}

export function resetFlowRegistryForTests(opts?: { persist?: boolean }) {
  flows.clear();
  restoreAttempted = false;
  resetFlowRegistryRuntimeForTests();
  if (opts?.persist !== false) {
    persistFlowRegistry();
    getFlowRegistryStore().close?.();
  }
}
