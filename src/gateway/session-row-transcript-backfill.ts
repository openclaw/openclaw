import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";
import type { SessionRowTranscriptReadParams } from "./session-row-transcript-backfill.types.js";

/** Optional transcript facts keep the row generation and foreground admission on the host. */
export async function backfillSessionRowTranscriptFields(
  params: Omit<SessionRowTranscriptReadParams, "includeTerminalModel"> & {
    shouldCommit?: () => boolean;
    model?: { selectedProvider: string; selectedModel: string; config?: OpenClawConfig };
  },
): Promise<{ lastMessagePreview?: string; fallbackModel?: { provider: string; model: string } }> {
  if (params.shouldCommit?.() === false) {
    return {};
  }
  const { shouldCommit, sessionEntry, model, ...scope } = params;
  const input: SessionRowTranscriptReadParams = {
    ...scope,
    includeTerminalModel: model !== undefined,
    sessionEntry: {
      sessionId: sessionEntry.sessionId,
      updatedAt: sessionEntry.updatedAt,
      status: sessionEntry.status,
      lastRunId: sessionEntry.lastRunId,
      fallbackNotice: sessionEntry.fallbackNotice ? { ...sessionEntry.fallbackNotice } : undefined,
    },
  };
  return withSessionHistoryWorkerDatabase(
    toDatabaseOptions(
      resolveSqliteTranscriptReadScope({
        ...input,
        agentId: params.storeAgentId ?? params.agentId,
      }),
    ),
    async (owner) => {
      const { terminalModel, ...fields } = await owner.readRowBackfill(input);
      owner.assertCurrent();
      if (shouldCommit?.() === false) {
        return {};
      }
      const fallback =
        model &&
        readSessionFallbackModel({
          ...model,
          sessionEntry,
          sessionScope: { ...scope, agentId: params.storeAgentId ?? params.agentId },
          terminalModel: terminalModel ?? null,
        });
      return {
        ...fields,
        ...(fallback
          ? { fallbackModel: { provider: fallback.modelProvider, model: fallback.model } }
          : {}),
      };
    },
  );
}
