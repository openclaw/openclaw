import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";
import type { SessionRowTranscriptReadParams } from "./session-row-transcript-backfill.types.js";
import type { SessionRowTranscriptProjection } from "./session-row-transcript-preview.js";

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
  fields: Pick<SessionRowTranscriptProjection, "lastMessagePreview" | "terminalModel">,
): { lastMessagePreview?: string; fallbackModel?: { provider: string; model: string } } {
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
    ...(fields.lastMessagePreview !== null
      ? { lastMessagePreview: fields.lastMessagePreview }
      : {}),
    ...(fallback
      ? { fallbackModel: { provider: fallback.modelProvider, model: fallback.model } }
      : {}),
  };
}

/** Optional transcript facts are published by the resident row owner. */
export async function backfillSessionRowTranscriptFields(params: BackfillParams) {
  const { model: _model, sessionEntry: _sessionEntry, ...input } = params;
  const options = toDatabaseOptions(
    resolveSqliteTranscriptReadScope({
      ...input,
      agentId: params.storeAgentId ?? params.agentId,
    }),
  );
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const source = createSessionWorkerExecutionSource(() => {}, "Session row backfill retired");
  try {
    const fields = await runOpenClawAgentWorkerWrite(
      options,
      () =>
        execution.runExisting(source, (worker) =>
          worker.execute({ type: "session.rowTranscript.backfill", input }),
        ),
      undefined,
      undefined,
      "background",
    );
    return fields ? presentSessionRowTranscriptFields(params, fields) : {};
  } finally {
    await execution.release();
  }
}
