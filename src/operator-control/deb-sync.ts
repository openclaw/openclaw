import {
  resolveProjectOpsEventTarget,
  resolveProjectOpsControlPlaneBaseUrl,
  resolveDirectDebBaseUrl,
} from "./project-ops-target.js";
import type { OperatorTaskRecord } from "./task-store.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type OperatorDebSyncReason = "submit" | "patch" | "receipt";

export type OperatorDebSyncStatusSnapshot = {
  mode: "task-lifecycle";
  targetMode: "control-plane-proxy" | "direct-deb" | null;
  configured: boolean;
  baseUrl: string | null;
  eventEndpoint: string | null;
  authScheme: "bearer" | null;
  authEnv: string | null;
  authConfigured: boolean;
  controlPlaneConfigured: boolean;
  directDebConfigured: boolean;
};

export type OperatorDebSyncResult = {
  attempted: boolean;
  accepted: boolean;
  endpoint: string | null;
  statusCode: number;
  message: string;
};

export function resolveDebBaseUrl(): string | null {
  return resolveProjectOpsEventTarget()?.baseUrl ?? null;
}

export function resolveDebSharedSecret(): string | null {
  return resolveProjectOpsEventTarget()?.authToken ?? null;
}

export function resolveDebOperatorEventEndpoint(): string | null {
  return resolveProjectOpsEventTarget()?.endpoint ?? null;
}

export function getOperatorDebSyncStatus(): OperatorDebSyncStatusSnapshot {
  const target = resolveProjectOpsEventTarget();
  return {
    mode: "task-lifecycle",
    targetMode: target?.mode ?? null,
    configured: Boolean(target),
    baseUrl: target?.baseUrl ?? null,
    eventEndpoint: resolveDebOperatorEventEndpoint(),
    authScheme: "bearer",
    authEnv: target?.authEnv ?? null,
    authConfigured: Boolean(target?.authToken),
    controlPlaneConfigured: Boolean(resolveProjectOpsControlPlaneBaseUrl()),
    directDebConfigured: Boolean(resolveDirectDebBaseUrl()),
  };
}

function createMessageFromResponse(response: Response, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const direct =
      asString(record.message) ??
      asString(record.status) ??
      asString(record.output) ??
      asString(record.error);
    if (direct) {
      return direct;
    }
  }
  return `${response.status} ${response.statusText}`;
}

function buildDebOperatorEvent(task: OperatorTaskRecord, reason: OperatorDebSyncReason) {
  const latestEvent = task.events.at(-1) ?? null;
  return {
    schema: "DebOperatorTaskSyncV1",
    reason,
    task_id: task.envelope.task_id,
    run_id: task.receipt.run_id,
    state: task.receipt.state,
    owner: task.receipt.owner ?? latestEvent?.owner ?? null,
    objective: task.envelope.objective,
    capability: task.envelope.target.capability,
    team_id: task.envelope.target.team_id ?? null,
    alias: task.envelope.target.alias ?? null,
    requester: task.envelope.requester,
    tier: task.envelope.tier,
    transport: task.envelope.execution.transport,
    runtime: task.envelope.execution.runtime,
    acceptance_criteria: task.envelope.acceptance_criteria,
    failure_code: task.receipt.failure_code ?? latestEvent?.failureCode ?? null,
    summary: latestEvent?.note ?? null,
    artifacts: task.receipt.artifacts,
    queue_latency_ms: task.receipt.queue_latency_ms,
    created_at: task.receipt.created_at,
    updated_at: task.receipt.updated_at,
    last_event_at: latestEvent?.at ?? task.receipt.updated_at,
    validation:
      task.validation === null
        ? null
        : {
            result: task.validation.result,
            validator: task.validation.validator,
            created_at: task.validation.created_at,
            checks: task.validation.checks.length,
          },
    outcome:
      task.outcome === null
        ? null
        : {
            outcome: task.outcome.outcome,
            verification_status: task.outcome.verification_status,
            rework_needed: task.outcome.rework_needed,
            recorded_at: task.outcome.recorded_at,
          },
  };
}

export async function syncOperatorTaskToDeb(
  task: OperatorTaskRecord | null,
  reason: OperatorDebSyncReason,
): Promise<OperatorDebSyncResult> {
  const target = resolveProjectOpsEventTarget();
  const endpoint = target?.endpoint ?? null;
  if (!task || !endpoint) {
    return {
      attempted: false,
      accepted: false,
      endpoint,
      statusCode: 0,
      message: endpoint ? "task not available for Deb sync" : "Deb sync not configured",
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(target?.authToken
          ? {
              authorization: `Bearer ${target.authToken}`,
            }
          : {}),
      },
      body: JSON.stringify(buildDebOperatorEvent(task, reason)),
    });
    const payload = await response.json().catch(() => null);
    return {
      attempted: true,
      accepted: response.ok,
      endpoint,
      statusCode: response.status,
      message: createMessageFromResponse(response, payload),
    };
  } catch (error) {
    return {
      attempted: true,
      accepted: false,
      endpoint,
      statusCode: 0,
      message: error instanceof Error ? error.message : "Deb sync failed",
    };
  }
}
