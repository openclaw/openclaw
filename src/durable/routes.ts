import { randomUUID } from "node:crypto";
import type { DurableRuntimeEvent, DurableRuntimeRef, DurableRuntimeStore } from "./types.js";

export type DurableReportRoutePolicy = "parent_only" | "child_progress" | "fan_in_output";

export type CreateDurableReportRouteInput = {
  store: DurableRuntimeStore;
  runtimeRunId: string;
  stepId?: string;
  routeId?: string;
  parentRouteId?: string;
  branchId?: string;
  channelRef?: string;
  policy?: DurableReportRoutePolicy;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type RecordDurableRouteProgressInput = {
  store: DurableRuntimeStore;
  runtimeRunId: string;
  stepId?: string;
  routeId: string;
  branchId?: string;
  progressType: "started" | "progress" | "completed" | "failed" | "suppressed";
  summary?: string;
  metadata?: Record<string, unknown>;
  now?: number;
};

export function createDurableReportRoute(input: CreateDurableReportRouteInput): DurableRuntimeRef {
  const routeId = input.routeId ?? `route_${randomUUID()}`;
  const metadata = {
    routeId,
    parentRouteId: input.parentRouteId,
    branchId: input.branchId,
    channelRef: input.channelRef,
    policy: input.policy ?? "child_progress",
    ...input.metadata,
  };
  const ref = input.store.createRef({
    refId: `route:${input.runtimeRunId}:${routeId}`,
    runtimeRunId: input.runtimeRunId,
    stepId: input.stepId,
    refKind: "artifact",
    mediaType: "application/vnd.openclaw.durable-report-route+json",
    storageKind: "inline",
    storageUri: `route:${routeId}`,
    metadata,
    now: input.now,
  });
  input.store.appendEvent({
    runtimeRunId: input.runtimeRunId,
    eventType: "runtime.route.created",
    eventTime: input.now,
    stepId: input.stepId,
    correlationId: routeId,
    payload: metadata,
  });
  return ref;
}

export function recordDurableRouteProgress(
  input: RecordDurableRouteProgressInput,
): DurableRuntimeEvent {
  return input.store.appendEvent({
    runtimeRunId: input.runtimeRunId,
    eventType: "runtime.route.progress",
    eventTime: input.now,
    stepId: input.stepId,
    correlationId: input.routeId,
    payload: {
      routeId: input.routeId,
      branchId: input.branchId,
      progressType: input.progressType,
      summary: input.summary,
      ...input.metadata,
    },
  });
}
