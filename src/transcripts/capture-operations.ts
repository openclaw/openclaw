import path from "node:path";
import { persistTranscriptSummary } from "./capture-summary.js";
import {
  activeSessions,
  finalizeTranscriptCapture,
  isTranscriptSelectionCurrent,
  isTranscriptSelectionOwned,
  isTranscriptSessionStarting,
  revokeTranscriptStartRetries,
  stopTranscriptProviderCapture,
  type TranscriptCaptureSelection,
  type TranscriptsRuntimeContext,
} from "./capture.js";
import { resolveTranscriptsConfig } from "./config.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsStore, TranscriptsSummaryChangedError } from "./store.js";

export function createTranscriptsStore(ctx: TranscriptsRuntimeContext): TranscriptsStore {
  return new TranscriptsStore(path.join(ctx.stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: ctx.stateDir },
  });
}

// Tool stop/import/summarize actions explicitly materialize artifacts, but a
// divergent export must not turn a successful canonical summary write into failure.
export async function exportTranscriptSummary(
  store: TranscriptsStore,
  session: TranscriptSessionDescriptor,
  { summary, intendedSummaryPath }: Awaited<ReturnType<typeof persistTranscriptSummary>>,
) {
  try {
    const artifacts = await store.materializeSessionArtifacts(session, "all");
    return { summary, summaryPath: artifacts.summaryPath };
  } catch (error) {
    return { summary, intendedSummaryPath, summaryExportError: String(error) };
  }
}

export async function stopTranscriptCapture(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  selection: TranscriptCaptureSelection;
}) {
  const { selection } = params;
  const { session, selector, selectedActive } = selection;
  const sessionId = session.sessionId;
  const skip = (reason: "inactive" | "starting" | "stopping") => ({
    status: "skipped" as const,
    reason,
    sessionId,
    selector,
  });
  // Authorization may await native policy while the provider retires this owner.
  const current = await isTranscriptSelectionCurrent(selection, params.store);
  params.ctx.assertCallerActive?.();
  if (!current || !isTranscriptSelectionOwned(selection)) {
    return skip("inactive");
  }
  if (isTranscriptSessionStarting(sessionId)) {
    return skip("starting");
  }
  if (selectedActive?.stopping) {
    return skip("stopping");
  }
  revokeTranscriptStartRetries(params.ctx, session);
  if (selectedActive) {
    selectedActive.stopping = true;
  }
  let finalized = false;
  try {
    let providerStopError: string | undefined;
    if (selectedActive && selectedActive.phase !== "terminal") {
      providerStopError = await stopTranscriptProviderCapture({
        ctx: params.ctx,
        entry: selectedActive,
        reason: "tool-stop",
      });
      if (activeSessions.get(sessionId) !== selectedActive) {
        return skip("inactive");
      }
    }
    if (providerStopError !== undefined && selectedActive?.phase !== "terminal") {
      throw new Error(
        `transcripts provider cleanup failed: ${providerStopError}. Use transcripts stop to retry.`,
      );
    }
    let persisted: Awaited<ReturnType<typeof persistTranscriptSummary>>;
    let stoppedSession: TranscriptSessionDescriptor;
    if (selectedActive) {
      persisted = await finalizeTranscriptCapture({ ...params, entry: selectedActive });
      stoppedSession = selectedActive.session;
      finalized = true;
    } else {
      const assertCurrent = () => {
        params.ctx.assertCallerActive?.();
        if (!isTranscriptSelectionOwned(selection) || isTranscriptSessionStarting(sessionId)) {
          throw new TranscriptsSummaryChangedError();
        }
      };
      stoppedSession = { ...session, stoppedAt: session.stoppedAt ?? new Date().toISOString() };
      if (!session.stoppedAt) {
        try {
          await params.store.writeSession(stoppedSession, {
            expectedInputRevision: selection.historicalRevision,
            assertCurrent,
          });
        } catch (error) {
          if (error instanceof TranscriptsSummaryChangedError) {
            return skip("inactive");
          }
          throw error;
        }
      }
      persisted = await persistTranscriptSummary({
        config: resolveTranscriptsConfig(params.ctx.config?.transcripts),
        cfg: params.ctx.config,
        store: params.store,
        session: stoppedSession,
        expectedInputRevision: session.stoppedAt ? selection.historicalRevision : undefined,
        assertCurrent,
      });
    }
    const { summaryPath, intendedSummaryPath, summary, summaryExportError } =
      await exportTranscriptSummary(params.store, stoppedSession, persisted);
    return {
      status: "stopped" as const,
      sessionId,
      selector,
      ...(providerStopError !== undefined ? { providerStopError } : {}),
      ...(summaryExportError ? { summaryExportError } : {}),
      ...(intendedSummaryPath ? { intendedSummaryPath } : {}),
      summary,
      ...(summaryPath ? { summaryPath } : {}),
    };
  } finally {
    if (selectedActive && activeSessions.get(sessionId) === selectedActive) {
      delete selectedActive.stopping;
      if (finalized) {
        activeSessions.delete(sessionId);
      }
    }
  }
}
