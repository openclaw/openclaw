import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/schema/environments.js";
import type { WorkerEnvironmentServiceRecord } from "./service-contract.js";
import type { WorkerEnvironmentState } from "./state.js";

const WORKER_STATUS: Record<WorkerEnvironmentState, EnvironmentSummary["status"]> = {
  requested: "starting",
  provisioning: "starting",
  bootstrapping: "starting",
  ready: "available",
  attached: "available",
  idle: "available",
  draining: "stopping",
  destroying: "stopping",
  destroyed: "unavailable",
  failed: "error",
  orphaned: "error",
};

/** Projects a durable worker row without exposing its SSH credential reference. */
export function summarizeWorkerEnvironment(
  record: WorkerEnvironmentServiceRecord,
  now = Date.now(),
): EnvironmentSummary {
  return {
    id: record.environmentId,
    type: "worker",
    status: WORKER_STATUS[record.state],
    ...(record.sharedHost === null
      ? {}
      : { trust: record.sharedHost ? "persistent" : "disposable" }),
    ...(record.desktopAvailable ? { desktop: true } : {}),
    ...(record.preparation
      ? { preparation: { purpose: record.preparation.purpose, key: record.preparation.key } }
      : {}),
    worker: {
      profileId: record.profileId,
      providerId: record.providerId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}),
      state: record.state,
      ageMs: Math.max(0, Math.trunc(now - record.createdAtMs)),
      ...(record.state === "idle" && record.idleSinceAtMs !== null
        ? { idleMs: Math.max(0, Math.trunc(now - record.idleSinceAtMs)) }
        : {}),
      attachedSessionIds: normalizeSortedUniqueTrimmedStringList(record.attachedSessionIds),
      tunnelStatus: record.tunnelStatus,
      ...((record.state === "failed" || record.state === "orphaned") && record.error
        ? { error: record.error }
        : {}),
      ...(record.desktopAvailable ? { desktop: true } : {}),
      ...(record.desktopApps.length > 0 ? { desktopApps: [...record.desktopApps] } : {}),
    },
  };
}
