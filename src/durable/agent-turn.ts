// Durable runtime lifecycle helpers for one agent turn.
import { createHash } from "node:crypto";
import { isDurableRuntimesEnabled } from "./config.js";
import { buildDurableIntakeEnvelope } from "./intake-envelope.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type {
  DurableRecoveryState,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeStore,
} from "./types.js";

export type DurableAgentTurnLifecycle = {
  runtimeRunId: string;
  markRunning(payload?: Record<string, unknown>): void;
  recordHeartbeat(payload?: Record<string, unknown>): void;
  markTerminal(params: {
    status: DurableRuntimeRunStatus;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isYieldedAgentTurnPayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) {
    return false;
  }
  const livenessState = asString(payload.livenessState)?.toLowerCase();
  const progressKind = asString(payload.openclawProgressKind) ?? asString(payload.progressKind);
  return (
    payload.yielded === true || livenessState === "paused" || progressKind === "agent-yield-paused"
  );
}

function resolveYieldedAgentTurnWaitState(params: {
  store: DurableRuntimeStore;
  runtimeRunId: string;
}): { status: DurableRuntimeRunStatus; recoveryState: DurableRecoveryState } {
  const hasChild = params.store.listChildLinks(params.runtimeRunId).length > 0;
  return hasChild
    ? { status: "waiting_child", recoveryState: "waiting_child" }
    : { status: "waiting_signal", recoveryState: "waiting_signal" };
}

function compactYieldPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) {
    return { yielded: true };
  }
  return {
    yielded: payload.yielded === true,
    livenessState: asString(payload.livenessState),
    openclawProgressKind: asString(payload.openclawProgressKind) ?? asString(payload.progressKind),
    summary: asString(payload.summary),
    stopReason: asString(payload.stopReason),
  };
}

function createNoopLifecycle(): DurableAgentTurnLifecycle {
  return {
    runtimeRunId: "",
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
  contextRefs?: readonly Record<string, unknown>[];
  env?: NodeJS.ProcessEnv;
}): DurableAgentTurnLifecycle {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return createNoopLifecycle();
  }

  let store: DurableRuntimeStore | null = null;
  let run: DurableRuntimeRun | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stepId = "agent_invocation";
  const messageHash = sha256(params.message);
  const inputRefId = `agent-turn:${params.runId}:input`;
  const intakeEnvelope = buildDurableIntakeEnvelope({
    operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
    runId: params.runId,
    sourceType: "agent.turn",
    sourceRef: params.sessionKey ?? params.agentId ?? "unknown",
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    transport: params.transport,
    deliver: params.deliver === true,
    message: params.message,
    messageHash,
    ...(params.contextRefs && params.contextRefs.length > 0
      ? { contextRefs: params.contextRefs }
      : {}),
    env,
  });
  const metadata = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    channel: params.channel,
    transport: params.transport,
    deliver: params.deliver === true,
    messageLength: params.message.length,
    messageHash,
    intakeEnvelope,
    ...(params.contextRefs && params.contextRefs.length > 0
      ? { contextRefs: params.contextRefs }
      : {}),
  };

  try {
    store = openDurableRuntimeStore({ env });
    run = store.createRun({
      operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
      operationVersion: "1",
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
      runtimeRunId: run.runtimeRunId,
      stepId,
      refKind: "input",
      mediaType: "application/vnd.openclaw.agent-turn+json",
      hash: messageHash,
      storageKind: "external",
      storageUri: inputRefId,
      metadata,
    });
    store.createStep({
      runtimeRunId: run.runtimeRunId,
      stepId,
      stepType: "agent",
      status: "queued",
      recoveryState: "runnable",
      inputRef: inputRef.refId,
      idempotencyKey: params.runId,
      metadata,
    });
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
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
        runtimeRunId: run.runtimeRunId,
        heartbeatAt: now,
        metadata,
        now,
      });
      store.updateStep({
        runtimeRunId: run.runtimeRunId,
        stepId,
        heartbeatAt: now,
        metadata,
        now,
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
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
    runtimeRunId: run.runtimeRunId,
    markRunning(payload?: Record<string, unknown>): void {
      safeCall(() => {
        if (!store || !run) {
          return;
        }
        store.updateRun({
          runtimeRunId: run.runtimeRunId,
          status: "running",
          recoveryState: "running",
          heartbeatAt: Date.now(),
          metadata,
        });
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId,
          status: "running",
          recoveryState: "running",
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
          metadata,
        });
        store.appendEvent({
          runtimeRunId: run.runtimeRunId,
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
        const now = Date.now();
        const terminalPayload = isRecord(paramsTerminal.payload)
          ? paramsTerminal.payload
          : undefined;
        if (paramsTerminal.status === "succeeded" && isYieldedAgentTurnPayload(terminalPayload)) {
          const waitState = resolveYieldedAgentTurnWaitState({
            store,
            runtimeRunId: run.runtimeRunId,
          });
          const yieldPayload = compactYieldPayload(terminalPayload);
          const checkpointRef = store.createRef({
            runtimeRunId: run.runtimeRunId,
            stepId,
            refKind: "artifact",
            mediaType: "application/vnd.openclaw.agent-turn-yield+json",
            storageKind: "external",
            storageUri: `agent-turn:${params.runId}:yield`,
            metadata: yieldPayload,
            now,
          });
          const waitMetadata = {
            ...metadata,
            lastYield: yieldPayload,
          };
          store.updateRun({
            runtimeRunId: run.runtimeRunId,
            status: waitState.status,
            recoveryState: waitState.recoveryState,
            checkpointRef: checkpointRef.refId,
            completedAt: null,
            metadata: waitMetadata,
            now,
          });
          store.updateStep({
            runtimeRunId: run.runtimeRunId,
            stepId,
            status: "waiting",
            recoveryState: waitState.recoveryState,
            checkpointRef: checkpointRef.refId,
            completedAt: null,
            metadata: waitMetadata,
            now,
          });
          store.appendEvent({
            runtimeRunId: run.runtimeRunId,
            eventType: "agent.turn.yielded",
            eventTime: now,
            stepId,
            agentInvocationId: params.runId,
            idempotencyKey: `${params.runId}:yield`,
            correlationId: params.sessionKey,
            payload: {
              ...yieldPayload,
              status: waitState.status,
              recoveryState: waitState.recoveryState,
            },
          });
          return;
        }
        const completedAt = now;
        store.updateRun({
          runtimeRunId: run.runtimeRunId,
          status: paramsTerminal.status,
          recoveryState: paramsTerminal.recoveryState ?? "terminal",
          completedAt,
          metadata,
          now: completedAt,
        });
        const ref =
          paramsTerminal.status === "succeeded"
            ? store.createRef({
                runtimeRunId: run.runtimeRunId,
                stepId,
                refKind: "output",
                mediaType: "application/vnd.openclaw.agent-turn-result+json",
                storageKind: "external",
                storageUri: `agent-turn:${params.runId}:output`,
                metadata: paramsTerminal.payload,
                now: completedAt,
              })
            : store.createRef({
                runtimeRunId: run.runtimeRunId,
                stepId,
                refKind: "error",
                mediaType: "application/vnd.openclaw.agent-turn-error+json",
                storageKind: "external",
                storageUri: `agent-turn:${params.runId}:error`,
                metadata: paramsTerminal.payload,
                now: completedAt,
              });
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
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
          runtimeRunId: run.runtimeRunId,
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
