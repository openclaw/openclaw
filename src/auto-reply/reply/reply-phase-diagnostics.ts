import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { diagnosticErrorCategory } from "../../infra/diagnostic-error-metadata.js";
import {
  type DiagnosticReplyPhaseName,
  emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled,
  resolveDiagnosticReplyPhaseGroup,
} from "../../infra/diagnostic-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";

type ReplyPhaseTimelineAttributes = Record<string, string | number | boolean | null>;

type ReplyPhaseDiagnosticsOptions = {
  attributes?: ReplyPhaseTimelineAttributes;
  channel?: string;
  config?: OpenClawConfig;
  model?: string;
  provider?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  timelinePhase?: string;
  trigger?: string;
};

function optionalStringAttr(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function emitReplyPhaseCompleted(
  phase: string,
  durationMs: number,
  outcome: "completed" | "error",
  options: ReplyPhaseDiagnosticsOptions,
  error?: unknown,
) {
  if (!isDiagnosticsEnabled(options.config)) {
    return;
  }
  const phaseGroup = resolveDiagnosticReplyPhaseGroup(phase);
  if (!phaseGroup) {
    return;
  }
  emitTrustedDiagnosticEvent({
    type: "reply.phase.completed",
    phase: phase as DiagnosticReplyPhaseName,
    phaseGroup,
    durationMs: Math.max(0, durationMs),
    outcome,
    ...(optionalStringAttr(options.channel)
      ? { channel: optionalStringAttr(options.channel) }
      : {}),
    ...(optionalStringAttr(options.provider)
      ? { provider: optionalStringAttr(options.provider) }
      : {}),
    ...(optionalStringAttr(options.model) ? { model: optionalStringAttr(options.model) } : {}),
    ...(optionalStringAttr(options.trigger)
      ? { trigger: optionalStringAttr(options.trigger) }
      : {}),
    ...(optionalStringAttr(options.runId) ? { runId: optionalStringAttr(options.runId) } : {}),
    ...(optionalStringAttr(options.sessionKey)
      ? { sessionKey: optionalStringAttr(options.sessionKey) }
      : {}),
    ...(optionalStringAttr(options.sessionId)
      ? { sessionId: optionalStringAttr(options.sessionId) }
      : {}),
    ...(outcome === "error" ? { errorCategory: diagnosticErrorCategory(error) } : {}),
  });
}

export async function measureReplyPhaseDiagnostics<T>(
  phase: string,
  run: () => Promise<T> | T,
  options: ReplyPhaseDiagnosticsOptions,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await measureDiagnosticsTimelineSpan(phase, run, {
      ...(options.timelinePhase ? { phase: options.timelinePhase } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.attributes ? { attributes: options.attributes } : {}),
    });
    emitReplyPhaseCompleted(phase, performance.now() - startedAt, "completed", options);
    return result;
  } catch (error) {
    emitReplyPhaseCompleted(phase, performance.now() - startedAt, "error", options, error);
    throw error;
  }
}
