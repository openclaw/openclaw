import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { NodeWorkerSupervisorReceipt } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

export type NodeWorkerTerminalState = Exclude<
  NodeWorkerSupervisorReceipt["state"],
  "pending" | "running"
>;

export type NodeWorkerCleanupMode = "process-group" | "owned-anchor" | "linux-subreaper";

export type NodeWorkerCleanupBinding = {
  databasePath: string;
  externallySupervised: boolean;
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
};

export type NodeWorkerContainerIdentity = {
  engine: "docker" | "podman";
  containerId: string;
  engineTarget: string;
};

export type NodeWorkerLaunchRow = Selectable<OpenClawStateDatabase["node_worker_launches"]> & {
  boot_id?: string | null;
  container_json?: string | null;
  cleanup_mode?: string | null;
  lineage_settled?: number | null;
  scope_kind?: string | null;
  descendants_reaped?: number | null;
};

export type NodeWorkerLaunchReceipt = ReturnType<typeof nodeWorkerLaunchReceiptFromRow>;

export function isNodeWorkerTerminalState(value: string): value is NodeWorkerTerminalState {
  return (
    value === "completed" || value === "failed" || value === "interrupted" || value === "cancelled"
  );
}

export function validateNodeWorkerPlanHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("node worker plan hash must be 64 lowercase hexadecimal characters");
  }
}

export function validateNodeWorkerProcessIdentity(identity: NodeWorkerProcessIdentity): void {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pid > 2_147_483_647 ||
    !Number.isSafeInteger(identity.startTime) ||
    identity.startTime < 0
  ) {
    throw new Error("node worker process identity must contain a bounded pid and start time");
  }
}

export function validateNodeWorkerContainerIdentity(identity: NodeWorkerContainerIdentity): void {
  if (identity.engine !== "docker" && identity.engine !== "podman") {
    throw new Error("node worker container engine must be docker or podman");
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.containerId)) {
    throw new Error(
      "node worker container id must contain exactly 64 lowercase hexadecimal digits",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.engineTarget)) {
    throw new Error(
      "node worker container engine target must contain exactly 64 lowercase hexadecimal digits",
    );
  }
}

function containerIdentity(value: string | null | undefined): NodeWorkerContainerIdentity | null {
  if (value == null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid node worker container identity");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    (parsed.engine !== "docker" && parsed.engine !== "podman") ||
    typeof parsed.containerId !== "string" ||
    typeof parsed.engineTarget !== "string"
  ) {
    throw new Error("invalid node worker container identity");
  }
  const identity: NodeWorkerContainerIdentity = {
    engine: parsed.engine,
    containerId: parsed.containerId,
    engineTarget: parsed.engineTarget,
  };
  validateNodeWorkerContainerIdentity(identity);
  return identity;
}

export function nodeWorkerLaunchReceiptFromRow(row: NodeWorkerLaunchRow) {
  if (row.state !== "pending" && row.state !== "running" && !isNodeWorkerTerminalState(row.state)) {
    throw new Error(`invalid node worker launch state ${row.state}`);
  }
  const container = containerIdentity(row.container_json);
  const cleanupMode = row.cleanup_mode ?? null;
  if (
    row.scope_kind != null &&
    (row.scope_kind !== "linux-subreaper" || cleanupMode !== "owned-anchor")
  ) {
    throw new Error("invalid node worker process scope");
  }
  if (cleanupMode !== null && cleanupMode !== "process-group" && cleanupMode !== "owned-anchor") {
    throw new Error("invalid node worker cleanup mode");
  }
  return {
    launchId: row.launch_id,
    planHash: row.plan_hash,
    gatewayNamespace: row.gateway_namespace,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
    runId: row.run_id,
    state: row.state,
    supervisor: { pid: row.supervisor_pid, startTime: row.supervisor_start_time },
    ...(row.boot_id ? { bootId: row.boot_id } : {}),
    worker:
      row.worker_pid === null || row.worker_start_time === null
        ? null
        : { pid: row.worker_pid, startTime: row.worker_start_time },
    workerCleanupMode:
      row.scope_kind === "linux-subreaper" ? ("linux-subreaper" as const) : cleanupMode,
    ...(row.scope_kind === "linux-subreaper"
      ? { workerDescendantsReaped: row.descendants_reaped === 1 }
      : {}),
    workerLineageSettled: row.lineage_settled === 1,
    ...(container ? { container } : {}),
    resultJson: row.result_json,
    errorText: row.error_text,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
