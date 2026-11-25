import { err, ok } from "@openclaw/normalization-core/result";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getGatewayRestartDrainSignal,
  getGatewayShutdownCleanupSignal,
} from "../process/gateway-work-admission.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";
import type { SessionRowTranscriptReadParams } from "./session-row-transcript-backfill.types.js";
import type {
  SessionRowAssistantMessage,
  SessionRowTranscriptProjection,
} from "./session-row-transcript-preview.js";

type BackfillParams = SessionRowTranscriptReadParams & {
  sessionEntry: Pick<
    InternalSessionEntry,
    "sessionId" | "updatedAt" | "status" | "lastRunId" | "fallbackNotice"
  >;
  model?: { selectedProvider: string; selectedModel: string; config?: OpenClawConfig };
};

/** Runtime alias and selected-model policy remain with the host, not the durable cache. */
export function presentSessionRowTranscriptFields(
  params: BackfillParams,
  fields: Pick<
    SessionRowTranscriptProjection,
    "hasMessages" | "lastMessagePreview" | "lastAssistantMessage" | "terminalModel"
  >,
): {
  hasMessages?: boolean;
  lastMessagePreview?: string;
  lastAssistantMessage?: SessionRowAssistantMessage;
  fallbackModel?: { provider: string; model: string };
} {
  const { sessionEntry, model, ...scope } = params;
  const terminal = fields.terminalModel;
  const fallback =
    model &&
    readSessionFallbackModel({
      ...model,
      sessionEntry,
      sessionScope: { ...scope, agentId: params.storeAgentId ?? params.agentId },
      terminalModel: terminal && terminal.runId === sessionEntry.lastRunId ? terminal : null,
    });
  return {
    hasMessages: fields.hasMessages,
    ...(fields.lastMessagePreview !== null
      ? { lastMessagePreview: fields.lastMessagePreview }
      : {}),
    ...(fields.lastAssistantMessage && typeof fields.lastAssistantMessage !== "string"
      ? { lastAssistantMessage: fields.lastAssistantMessage }
      : {}),
    ...(fallback
      ? { fallbackModel: { provider: fallback.modelProvider, model: fallback.model } }
      : {}),
  };
}

/**
 * Optional transcript facts are published by the resident row owner. Every read stops once the
 * Gateway drains or closes, so work that ends during shutdown cannot reopen a sealed store.
 */
export async function backfillSessionRowTranscriptFields(params: BackfillParams) {
  const signal = AbortSignal.any([
    getGatewayRestartDrainSignal(),
    getGatewayShutdownCleanupSignal(),
  ]);
  signal.throwIfAborted();
  const { model: _model, sessionEntry: _sessionEntry, ...input } = params;
  const options = toDatabaseOptions(
    resolveSqliteTranscriptReadScope({
      ...input,
      agentId: params.storeAgentId ?? params.agentId,
    }),
  );
  const captured = captureOpenClawAgentDatabaseExecutionAsync(options).then(
    (execution) => ok(execution),
    (error: unknown) => err<never, unknown>(error),
  );
  const source = createSessionWorkerExecutionSource(
    () => signal.throwIfAborted(),
    "Session row backfill retired",
  );
  try {
    const fields = await runOpenClawAgentWorkerWrite(
      options,
      async () => {
        const acquired = await captured;
        if (!acquired.ok) {
          throw acquired.error;
        }
        const execution = acquired.value;
        return execution.runExisting(source, (worker) =>
          worker.execute({ type: "session.rowTranscript.backfill", input }),
        );
      },
      undefined,
      signal,
      "background",
    );
    return fields ? presentSessionRowTranscriptFields(params, fields) : undefined;
  } finally {
    const acquired = await captured;
    if (acquired.ok) {
      await acquired.value.release();
    }
  }
}

/**
 * Unread follows the chat: a run end advances activity to its transcript's newest visible
 * assistant row. Silent, heartbeat and hidden replies are not visible rows. The read is
 * optional; on failure the run end leaves unread unchanged.
 */
export async function readVisibleSessionActivityAt(params: BackfillParams) {
  const fields = await backfillSessionRowTranscriptFields(params).catch(() => undefined);
  return fields?.lastAssistantMessage?.timestamp;
}
