// Durable workflow lifecycle helpers for one agent turn.
import { createHash } from "node:crypto";
import { isDurableWorkflowsEnabled } from "./config.js";
import { openDurableWorkflowStore } from "./store-factory.js";
import type {
  DurableRecoveryState,
  DurableWorkflowRun,
  DurableWorkflowRunStatus,
  DurableWorkflowStore,
} from "./types.js";
import { DURABLE_AGENT_TURN_WORKFLOW_ID } from "./workflow-ids.js";

export type DurableAgentTurnLifecycle = {
  workflowRunId: string;
  markRunning(payload?: Record<string, unknown>): void;
  recordHeartbeat(payload?: Record<string, unknown>): void;
  markTerminal(params: {
    status: DurableWorkflowRunStatus;
    recoveryState?: DurableRecoveryState;
    eventType: string;
    payload?: Record<string, unknown>;
  }): void;
  close(): void;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactErrorPayload(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // Durable recording must never make the user-facing turn fail.
  }
}

function createNoopLifecycle(): DurableAgentTurnLifecycle {
  return {
    workflowRunId: "",
    markRunning: () => {},
    recordHeartbeat: () => {},
    markTerminal: () => {},
    close: () => {},
  };
}

function resolveHeartbeatIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_DURABLE_AGENT_TURN_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === "") {
    return 30_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30_000;
  }
  return Math.trunc(parsed);
}

export function startDurableAgentTurnLifecycle(params: {
  runId: string;
  message: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  transport: "gateway" | "local";
  deliver?: boolean;
  env?: NodeJS.ProcessEnv;
}): DurableAgentTurnLifecycle {
  const env = params.env ?? process.env;
  if (!isDurableWorkflowsEnabled(env)) {
    return createNoopLifecycle();
  }

  let store: DurableWorkflowStore | null = null;
  let run: DurableWorkflowRun | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stepId = "agent_invocation";
  const messageHash = sha256(params.message);
  const inputRefId = `agent-turn:${params.runId}:input`;
  const metadata = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    channel: params.channel,
    transport: params.transport,
    deliver: params.deliver === true,
    messageLength: params.message.length,
    messageHash,
  };

  try {
    store = openDurableWorkflowStore({ env });
    run = store.createRun({
      workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
      workflowVersion: "1",
      status: "received",
      recoveryState: "runnable",
      idempotencyKey: params.runId,
      requestHash: messageHash,
      sourceType: "agent",
      sourceRef: params.sessionKey ?? params.agentId ?? "unknown",
      inputRef: inputRefId,
      metadata,
    });
    const inputRef = store.createRef({
      refId: inputRefId,
      workflowRunId: run.workflowRunId,
      stepId,
      refKind: "input",
      mediaType: "application/vnd.openclaw.agent-turn+json",
      hash: messageHash,
      storageKind: "external",
      storageUri: inputRefId,
      metadata,
    });
    store.createStep({
      workflowRunId: run.workflowRunId,
      stepId,
      stepType: "agent",
      status: "queued",
      recoveryState: "runnable",
      inputRef: inputRef.refId,
      idempotencyKey: params.runId,
      metadata,
    });
    store.appendEvent({
      workflowRunId: run.workflowRunId,
      eventType: "agent.turn.received",
      stepId: "intake",
      agentInvocationId: params.runId,
      idempotencyKey: params.runId,
      correlationId: params.sessionKey,
      payload: metadata,
      payloadHash: messageHash,
    });
  } catch {
    store?.close();
    return createNoopLifecycle();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function recordHeartbeat(payload?: Record<string, unknown>): void {
    safeCall(() => {
      if (!store || !run) {
        return;
      }
      const now = Date.now();
      store.updateRun({
        workflowRunId: run.workflowRunId,
        heartbeatAt: now,
        metadata,
        now,
      });
      store.updateStep({
        workflowRunId: run.workflowRunId,
        stepId,
        heartbeatAt: now,
        metadata,
        now,
      });
      store.appendEvent({
        workflowRunId: run.workflowRunId,
        eventType: "agent.turn.heartbeat",
        eventTime: now,
        stepId,
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:heartbeat:${now}`,
        correlationId: params.sessionKey,
        payload: payload ?? { heartbeatAt: now },
      });
    });
  }

  function startHeartbeat(): void {
    const intervalMs = resolveHeartbeatIntervalMs(env);
    if (intervalMs <= 0 || heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      recordHeartbeat();
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  return {
    workflowRunId: run.workflowRunId,
    markRunning(payload?: Record<string, unknown>): void {
      safeCall(() => {
        if (!store || !run) {
          return;
        }
        store.updateRun({
          workflowRunId: run.workflowRunId,
          status: "running",
          recoveryState: "running",
          heartbeatAt: Date.now(),
          metadata,
        });
        store.updateStep({
          workflowRunId: run.workflowRunId,
          stepId,
          status: "running",
          recoveryState: "running",
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
          metadata,
        });
        store.appendEvent({
          workflowRunId: run.workflowRunId,
          eventType: "agent.turn.running",
          stepId: "agent_invocation",
          agentInvocationId: params.runId,
          idempotencyKey: params.runId,
          correlationId: params.sessionKey,
          payload,
        });
        startHeartbeat();
      });
    },
    recordHeartbeat,
    markTerminal(paramsTerminal): void {
      safeCall(() => {
        if (!store || !run) {
          return;
        }
        stopHeartbeat();
        const completedAt = Date.now();
        store.updateRun({
          workflowRunId: run.workflowRunId,
          status: paramsTerminal.status,
          recoveryState: paramsTerminal.recoveryState ?? "terminal",
          completedAt,
          metadata,
          now: completedAt,
        });
        const ref =
          paramsTerminal.status === "succeeded"
            ? store.createRef({
                workflowRunId: run.workflowRunId,
                stepId,
                refKind: "output",
                mediaType: "application/vnd.openclaw.agent-turn-result+json",
                storageKind: "external",
                storageUri: `agent-turn:${params.runId}:output`,
                metadata: paramsTerminal.payload,
                now: completedAt,
              })
            : store.createRef({
                workflowRunId: run.workflowRunId,
                stepId,
                refKind: "error",
                mediaType: "application/vnd.openclaw.agent-turn-error+json",
                storageKind: "external",
                storageUri: `agent-turn:${params.runId}:error`,
                metadata: paramsTerminal.payload,
                now: completedAt,
              });
        store.updateStep({
          workflowRunId: run.workflowRunId,
          stepId,
          status:
            paramsTerminal.status === "succeeded"
              ? "succeeded"
              : paramsTerminal.status === "cancelled"
                ? "cancelled"
                : paramsTerminal.status === "lost"
                  ? "lost"
                  : "failed",
          recoveryState: paramsTerminal.recoveryState ?? "terminal",
          ...(paramsTerminal.status === "succeeded"
            ? { outputRef: ref.refId }
            : { errorRef: ref.refId }),
          completedAt,
          metadata,
          now: completedAt,
        });
        store.appendEvent({
          workflowRunId: run.workflowRunId,
          eventType: paramsTerminal.eventType,
          eventTime: completedAt,
          stepId: "terminal",
          agentInvocationId: params.runId,
          idempotencyKey: params.runId,
          correlationId: params.sessionKey,
          payload: paramsTerminal.payload,
        });
      });
    },
    close(): void {
      stopHeartbeat();
      store?.close();
      store = null;
    },
  };
}

export function durableAgentTurnErrorPayload(error: unknown): Record<string, unknown> {
  return compactErrorPayload(error);
}
