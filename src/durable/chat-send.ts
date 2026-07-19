import { createHash } from "node:crypto";
import type { DurableRuntimeConfig } from "../config/types.durable.js";
import { isDurableAuthorityEnabled, isDurableRuntimeEnabled } from "./config.js";
import { recordDurableRuntimeHealthFailure, recordDurableRuntimeHealthSuccess } from "./health.js";
import { DURABLE_CHAT_SEND_OPERATION_KIND } from "./runtime-ids.js";
import { openDurableRuntimeStore } from "./store-factory.js";

type WarnLogger = { warn?: (message: string) => void };
type ChatSendTerminalStatus = "succeeded" | "failed" | "cancelled" | "lost";

function messageHash(params: {
  sessionKey: string;
  agentId?: string;
  message: string;
  attachmentCount: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionKey: params.sessionKey,
        agentId: params.agentId ?? null,
        message: params.message,
        attachmentCount: params.attachmentCount,
      }),
    )
    .digest("hex");
}

export function recordDurableChatSendIntake(params: {
  runId: string;
  sessionKey: string;
  agentId?: string;
  message: string;
  attachmentCount: number;
  config?: DurableRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  log?: WarnLogger;
  now?: number;
}): void {
  if (!isDurableRuntimeEnabled(params.config)) {
    return;
  }
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const requestHash = messageHash(params);
  const inputRefId = `chat-send:${params.runId}:input`;
  const metadata = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    reportRouteId: params.sessionKey,
    messageLength: params.message.length,
    messageHash: requestHash,
    attachmentCount: params.attachmentCount,
    replay: {
      inputAvailability: "metadata_only",
      canReplay: false,
      reason: "chat intake stores metadata and hashes only; retry requires the source session",
    },
  };
  let store: ReturnType<typeof openDurableRuntimeStore> | undefined;
  try {
    store = openDurableRuntimeStore({ env });
    store.withTransaction(() => {
      const run = store!.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        operationVersion: "1",
        status: "received",
        recoveryState: "runnable",
        idempotencyKey: params.runId,
        requestHash,
        sourceOwner: "session_store",
        sourceRef: params.sessionKey,
        messageId: params.runId,
        turnId: params.runId,
        reportRouteId: params.sessionKey,
        inputRef: inputRefId,
        metadata,
        now,
      });
      const inputRef = store!.createRef({
        refId: inputRefId,
        runtimeRunId: run.runtimeRunId,
        stepId: "intake",
        refKind: "input",
        mediaType: "application/vnd.openclaw.chat-send+json",
        hash: requestHash,
        storageKind: "external",
        storageUri: inputRefId,
        metadata,
        now,
      });
      store!.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "intake",
        stepType: "checkpoint",
        status: "queued",
        recoveryState: "runnable",
        inputRef: inputRef.refId,
        idempotencyKey: `${params.runId}:intake`,
        metadata,
        now,
      });
      store!.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "chat.send.received",
        eventTime: now,
        stepId: "intake",
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:received`,
        correlationId: params.sessionKey,
        payload: metadata,
        payloadHash: requestHash,
      });
    });
    recordDurableRuntimeHealthSuccess(now);
  } catch (error) {
    recordDurableRuntimeHealthFailure({
      component: "intake",
      operation: "chat_send_intake",
      error,
      now,
    });
    params.log?.warn?.(
      `failed to record durable chat.send intake ${params.runId}: ${String(error)}`,
    );
    if (isDurableAuthorityEnabled(params.config)) {
      throw error;
    }
  } finally {
    store?.close();
  }
}

export function recordDurableChatSendTerminal(params: {
  runId: string;
  sessionKey: string;
  status: ChatSendTerminalStatus;
  agentId?: string;
  summary?: string;
  config?: DurableRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  log?: WarnLogger;
  now?: number;
}): void {
  if (!isDurableRuntimeEnabled(params.config)) {
    return;
  }
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const metadata = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    reportRouteId: params.sessionKey,
    status: params.status,
    summary: params.summary,
  };
  let store: ReturnType<typeof openDurableRuntimeStore> | undefined;
  try {
    store = openDurableRuntimeStore({ env });
    store.withTransaction(() => {
      const run = store!.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        operationVersion: "1",
        idempotencyKey: params.runId,
        sourceOwner: "session_store",
        sourceRef: params.sessionKey,
        messageId: params.runId,
        turnId: params.runId,
        reportRouteId: params.sessionKey,
        metadata,
        now,
      });
      if (run.completedAt !== undefined) {
        return;
      }
      store!.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "intake",
        stepType: "checkpoint",
        idempotencyKey: `${params.runId}:intake`,
        metadata,
        now,
      });
      const refKind = params.status === "succeeded" ? "output" : "error";
      const refId = `chat-send:${params.runId}:${refKind}`;
      const ref =
        store!.getRef(refId) ??
        store!.createRef({
          refId,
          runtimeRunId: run.runtimeRunId,
          stepId: "intake",
          refKind,
          mediaType:
            params.status === "succeeded"
              ? "application/vnd.openclaw.chat-send-result+json"
              : "application/vnd.openclaw.chat-send-error+json",
          storageKind: "external",
          storageUri: refId,
          metadata,
          now,
        });
      store!.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: params.status,
        recoveryState: "terminal",
        completedAt: now,
        metadata,
        now,
      });
      store!.updateStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "intake",
        status: params.status,
        recoveryState: "terminal",
        completedAt: now,
        ...(params.status === "succeeded" ? { outputRef: ref.refId } : { errorRef: ref.refId }),
        metadata,
        now,
      });
      store!.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: `chat.send.${params.status}`,
        eventTime: now,
        stepId: "terminal",
        agentInvocationId: params.runId,
        idempotencyKey: `${params.runId}:terminal`,
        correlationId: params.sessionKey,
        payload: metadata,
      });
    });
    recordDurableRuntimeHealthSuccess(now);
  } catch (error) {
    recordDurableRuntimeHealthFailure({
      component: "agent_turn",
      operation: "chat_send_terminal",
      error,
      now,
    });
    params.log?.warn?.(
      `failed to record durable chat.send terminal ${params.runId}: ${String(error)}`,
    );
  } finally {
    store?.close();
  }
}
