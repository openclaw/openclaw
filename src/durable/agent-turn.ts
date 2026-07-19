// Durable runtime lifecycle helpers for one agent turn.
import { createHash } from "node:crypto";
import type { DurableRuntimeConfig } from "../config/types.durable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isAbandonedLivenessState, isBlockedLivenessState } from "../shared/agent-liveness.js";
import { isDurableAuthorityEnabled, isDurableRuntimeEnabled } from "./config.js";
import { recordDurableRuntimeHealthFailure, recordDurableRuntimeHealthSuccess } from "./health.js";
import { buildDurableIntakeEnvelope } from "./intake-envelope.js";
import { DURABLE_AGENT_TURN_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore, openDurableRuntimeStoreReadOnly } from "./store-factory.js";
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

export type DurableAgentTurnTerminalClassification = {
  status: Extract<DurableRuntimeRunStatus, "cancelled" | "failed" | "succeeded">;
  eventType:
    | "agent.turn.abandoned"
    | "agent.turn.blocked"
    | "agent.turn.cancelled"
    | "agent.turn.failed"
    | "agent.turn.succeeded";
};

export type DurableAgentTurnResultState = {
  aborted: boolean;
  failed: boolean;
  yielded: boolean;
  livenessState?: string;
  openclawProgressKind?: string;
  stopReason?: string;
};

const log = createSubsystemLogger("durable/agent-turn");

export function classifyDurableAgentTurnTerminal(params: {
  aborted: boolean;
  failed?: boolean;
  livenessState?: unknown;
}): DurableAgentTurnTerminalClassification {
  if (params.aborted) {
    return { status: "cancelled", eventType: "agent.turn.cancelled" };
  }
  if (isBlockedLivenessState(params.livenessState)) {
    return { status: "failed", eventType: "agent.turn.blocked" };
  }
  if (isAbandonedLivenessState(params.livenessState)) {
    return { status: "failed", eventType: "agent.turn.abandoned" };
  }
  if (params.failed) {
    return { status: "failed", eventType: "agent.turn.failed" };
  }
  return { status: "succeeded", eventType: "agent.turn.succeeded" };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactErrorPayload(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

function recordLifecycleMutation(params: {
  action: () => void;
  config?: DurableRuntimeConfig;
  operation: string;
  failBeforeAcceptance?: boolean;
}): boolean {
  try {
    params.action();
    recordDurableRuntimeHealthSuccess();
    return true;
  } catch (error) {
    recordDurableRuntimeHealthFailure({
      component: "agent_turn",
      operation: params.operation,
      error,
    });
    log.error(`durable agent turn ${params.operation} failed: ${String(error)}`);
    if (params.failBeforeAcceptance && isDurableAuthorityEnabled(params.config)) {
      throw error;
    }
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readResultRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function resolveDurableAgentTurnResultState(params: {
  result?: unknown;
  aborted?: boolean;
  failed?: boolean;
}): DurableAgentTurnResultState {
  const result = readResultRecord(params.result);
  const meta = readResultRecord(result?.meta);
  let yielded = meta?.yielded === true;
  let livenessState = asString(meta?.livenessState);
  let openclawProgressKind = asString(meta?.openclawProgressKind) ?? asString(meta?.progressKind);
  const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
  for (const payload of payloads) {
    const channelData = readResultRecord(readResultRecord(payload)?.channelData);
    yielded = yielded || channelData?.yielded === true;
    livenessState ??= asString(channelData?.livenessState);
    openclawProgressKind ??=
      asString(channelData?.openclawProgressKind) ?? asString(channelData?.progressKind);
  }
  const stopReason = asString(meta?.stopReason);
  return {
    aborted: params.aborted === true || meta?.aborted === true,
    failed:
      params.failed === true ||
      meta?.error !== undefined ||
      meta?.fallbackExhaustedFailure === true ||
      stopReason === "error" ||
      stopReason === "timeout" ||
      asString(meta?.timeoutPhase) !== undefined,
    yielded,
    ...(livenessState ? { livenessState } : {}),
    ...(openclawProgressKind ? { openclawProgressKind } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

export function completeDurableAgentTurnLifecycle(params: {
  lifecycle: DurableAgentTurnLifecycle;
  result?: unknown;
  error?: unknown;
  aborted?: boolean;
  failed?: boolean;
  summary?: string;
}): DurableAgentTurnTerminalClassification {
  const state = resolveDurableAgentTurnResultState({
    result: params.result,
    aborted: params.aborted,
    failed: params.failed === true || params.error !== undefined,
  });
  const terminal = classifyDurableAgentTurnTerminal(state);
  params.lifecycle.markTerminal({
    status: terminal.status,
    eventType: terminal.eventType,
    payload: {
      summary:
        params.summary ??
        (terminal.status === "succeeded"
          ? state.yielded
            ? "yielded"
            : "completed"
          : terminal.status === "cancelled"
            ? "cancelled"
            : (state.livenessState ?? "failed")),
      ...(state.yielded ? { yielded: true } : {}),
      ...(state.livenessState ? { livenessState: state.livenessState } : {}),
      ...(state.openclawProgressKind ? { openclawProgressKind: state.openclawProgressKind } : {}),
      ...(state.stopReason ? { stopReason: state.stopReason } : {}),
      ...(params.error !== undefined ? { error: compactErrorPayload(params.error) } : {}),
    },
  });
  return terminal;
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

const AGENT_TURN_HEARTBEAT_INTERVAL_MS = 30_000;

export function hasUnresolvedDurableSessionSideEffectUncertainty(params: {
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const store = openDurableRuntimeStoreReadOnly({ env: params.env });
  try {
    return store
      .listUncertaintyFacts({
        sourceOwner: "session_store",
        sourceRef: sessionKey,
        status: "open",
        limit: 5_000,
      })
      .some((fact) => fact.kind === "lost_after_dispatch");
  } finally {
    store.close();
  }
}

export function startDurableAgentTurnLifecycle(params: {
  runId: string;
  message: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  transport: "channel" | "cron" | "gateway" | "local";
  deliver?: boolean;
  contextRefs?: readonly Record<string, unknown>[];
  config?: DurableRuntimeConfig;
  env?: NodeJS.ProcessEnv;
}): DurableAgentTurnLifecycle {
  const env = params.env ?? process.env;
  if (!isDurableRuntimeEnabled(params.config)) {
    return createNoopLifecycle();
  }

  let store: DurableRuntimeStore | null = null;
  let run: DurableRuntimeRun | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  const stepId = "agent_invocation";
  const messageHash = sha256(params.message);
  const inputRefId = `agent-turn:${params.runId}:input`;
  const sourceOwner = params.sessionKey ? "session_store" : "agent_runtime";
  const sourceRef = params.sessionKey ?? params.runId;
  const intakeEnvelope = buildDurableIntakeEnvelope({
    operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
    runId: params.runId,
    sourceOwner,
    sourceRef,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    transport: params.transport,
    deliver: params.deliver === true,
    message: params.message,
    messageHash,
    ...(params.contextRefs && params.contextRefs.length > 0
      ? { contextRefs: params.contextRefs }
      : {}),
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
    const durableStore = openDurableRuntimeStore({ env });
    store = durableStore;
    run = durableStore.withTransaction(() => {
      const durableRun = durableStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        operationVersion: "1",
        status: "received",
        recoveryState: "runnable",
        idempotencyKey: params.runId,
        requestHash: messageHash,
        sourceOwner,
        sourceRef,
        inputRef: inputRefId,
        metadata,
      });
      const inputRef = durableStore.createRef({
        refId: inputRefId,
        runtimeRunId: durableRun.runtimeRunId,
        stepId,
        refKind: "input",
        mediaType: "application/vnd.openclaw.agent-turn+json",
        hash: messageHash,
        storageKind: "external",
        storageUri: inputRefId,
        metadata,
      });
      durableStore.createStep({
        runtimeRunId: durableRun.runtimeRunId,
        stepId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        inputRef: inputRef.refId,
        idempotencyKey: params.runId,
        metadata,
      });
      durableStore.appendEvent({
        runtimeRunId: durableRun.runtimeRunId,
        eventType: "agent.turn.received",
        stepId: "intake",
        agentInvocationId: params.runId,
        idempotencyKey: params.runId,
        correlationId: params.sessionKey,
        payload: metadata,
        payloadHash: messageHash,
      });
      return durableRun;
    });
    recordDurableRuntimeHealthSuccess();
  } catch (error) {
    store?.close();
    recordDurableRuntimeHealthFailure({
      component: "intake",
      operation: "agent_turn_intake",
      error,
    });
    log.error(`durable agent turn intake failed: ${String(error)}`);
    if (isDurableAuthorityEnabled(params.config)) {
      throw error;
    }
    return createNoopLifecycle();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function recordHeartbeat(payload?: Record<string, unknown>): void {
    recordLifecycleMutation({
      config: params.config,
      operation: "heartbeat",
      action: () => {
        if (!store || !run) {
          return;
        }
        const durableStore = store;
        const durableRun = run;
        durableStore.withTransaction(() => {
          const now = Date.now();
          durableStore.updateRun({
            runtimeRunId: durableRun.runtimeRunId,
            heartbeatAt: now,
            metadata,
            now,
          });
          durableStore.updateStep({
            runtimeRunId: durableRun.runtimeRunId,
            stepId,
            heartbeatAt: now,
            metadata,
            now,
          });
          durableStore.appendEvent({
            runtimeRunId: durableRun.runtimeRunId,
            eventType: "agent.turn.heartbeat",
            eventTime: now,
            stepId,
            agentInvocationId: params.runId,
            idempotencyKey: `${params.runId}:heartbeat:${now}`,
            correlationId: params.sessionKey,
            payload: payload ?? { heartbeatAt: now },
          });
        });
      },
    });
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      recordHeartbeat();
    }, AGENT_TURN_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  return {
    runtimeRunId: run.runtimeRunId,
    markRunning(payload?: Record<string, unknown>): void {
      recordLifecycleMutation({
        config: params.config,
        operation: "mark_running",
        failBeforeAcceptance: true,
        action: () => {
          if (!store || !run) {
            return;
          }
          const durableStore = store;
          const durableRun = run;
          durableStore.withTransaction(() => {
            const now = Date.now();
            durableStore.updateRun({
              runtimeRunId: durableRun.runtimeRunId,
              status: "running",
              recoveryState: "running",
              heartbeatAt: now,
              metadata,
              now,
            });
            durableStore.updateStep({
              runtimeRunId: durableRun.runtimeRunId,
              stepId,
              status: "running",
              recoveryState: "running",
              startedAt: now,
              heartbeatAt: now,
              metadata,
              now,
            });
            durableStore.appendEvent({
              runtimeRunId: durableRun.runtimeRunId,
              eventType: "agent.turn.running",
              eventTime: now,
              stepId: "agent_invocation",
              agentInvocationId: params.runId,
              idempotencyKey: params.runId,
              correlationId: params.sessionKey,
              payload,
            });
          });
          startHeartbeat();
        },
      });
    },
    recordHeartbeat,
    markTerminal(paramsTerminal): void {
      if (settled) {
        return;
      }
      const recorded = recordLifecycleMutation({
        config: params.config,
        operation: "mark_terminal",
        action: () => {
          if (!store || !run) {
            return;
          }
          const durableStore = store;
          const durableRun = run;
          durableStore.withTransaction(() => {
            const now = Date.now();
            const terminalPayload = isRecord(paramsTerminal.payload)
              ? paramsTerminal.payload
              : undefined;
            if (
              paramsTerminal.status === "succeeded" &&
              isYieldedAgentTurnPayload(terminalPayload)
            ) {
              const waitState = resolveYieldedAgentTurnWaitState({
                store: durableStore,
                runtimeRunId: durableRun.runtimeRunId,
              });
              const yieldPayload = compactYieldPayload(terminalPayload);
              const checkpointRef = durableStore.createRef({
                runtimeRunId: durableRun.runtimeRunId,
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
              durableStore.updateRun({
                runtimeRunId: durableRun.runtimeRunId,
                status: waitState.status,
                recoveryState: waitState.recoveryState,
                checkpointRef: checkpointRef.refId,
                completedAt: null,
                metadata: waitMetadata,
                now,
              });
              durableStore.updateStep({
                runtimeRunId: durableRun.runtimeRunId,
                stepId,
                status: "waiting",
                recoveryState: waitState.recoveryState,
                checkpointRef: checkpointRef.refId,
                completedAt: null,
                metadata: waitMetadata,
                now,
              });
              durableStore.appendEvent({
                runtimeRunId: durableRun.runtimeRunId,
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
            durableStore.updateRun({
              runtimeRunId: durableRun.runtimeRunId,
              status: paramsTerminal.status,
              recoveryState: paramsTerminal.recoveryState ?? "terminal",
              completedAt,
              metadata,
              now: completedAt,
            });
            const ref =
              paramsTerminal.status === "succeeded"
                ? durableStore.createRef({
                    runtimeRunId: durableRun.runtimeRunId,
                    stepId,
                    refKind: "output",
                    mediaType: "application/vnd.openclaw.agent-turn-result+json",
                    storageKind: "external",
                    storageUri: `agent-turn:${params.runId}:output`,
                    metadata: paramsTerminal.payload,
                    now: completedAt,
                  })
                : durableStore.createRef({
                    runtimeRunId: durableRun.runtimeRunId,
                    stepId,
                    refKind: "error",
                    mediaType: "application/vnd.openclaw.agent-turn-error+json",
                    storageKind: "external",
                    storageUri: `agent-turn:${params.runId}:error`,
                    metadata: paramsTerminal.payload,
                    now: completedAt,
                  });
            durableStore.updateStep({
              runtimeRunId: durableRun.runtimeRunId,
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
            durableStore.appendEvent({
              runtimeRunId: durableRun.runtimeRunId,
              eventType: paramsTerminal.eventType,
              eventTime: completedAt,
              stepId: "terminal",
              agentInvocationId: params.runId,
              idempotencyKey: params.runId,
              correlationId: params.sessionKey,
              payload: paramsTerminal.payload,
            });
          });
          stopHeartbeat();
        },
      });
      if (recorded) {
        settled = true;
      }
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
