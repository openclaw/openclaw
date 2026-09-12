import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { readSessionTranscriptBoundedMessageTailPage } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";

/** Reads a terminal fallback model only when the run, selection, and notice agree. */
export function readSessionFallbackModel(params: {
  selectedProvider: string;
  selectedModel: string;
  parseSelectedProvider?: boolean;
  config?: OpenClawConfig;
  sessionEntry?: InternalSessionEntry;
  sessionScope?: Pick<SessionTranscriptReadScope, "agentId" | "sessionKey" | "storePath">;
}): { modelProvider: string; model: string } | undefined {
  const entry = params.sessionEntry;
  if (
    !params.sessionScope?.sessionKey ||
    !entry?.sessionId ||
    entry.status !== "done" ||
    !entry.lastRunId ||
    !entry.fallbackNotice
  ) {
    return undefined;
  }
  const selectedLabel = resolveSelectedAndActiveModel({
    selectedProvider: params.selectedProvider,
    selectedModel: params.selectedModel,
    parseSelectedProvider: params.parseSelectedProvider,
  }).selected.label;
  if (normalizeOptionalString(entry.fallbackNotice.selectedModel) !== selectedLabel) {
    return undefined;
  }
  try {
    const page = readSessionTranscriptBoundedMessageTailPage(
      { ...params.sessionScope, sessionId: entry.sessionId },
      { maxBytes: 256 * 1024, maxMessages: 1, offset: 0 },
    );
    const message = asOptionalRecord(asOptionalRecord(page.events[0]?.event)?.message);
    if (
      (message?.stopReason === "stop" || message?.stopReason === "length") &&
      readSessionTranscriptRunId(message) === entry.lastRunId &&
      projectSessionDisplayMessage(message)?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      const { selected, active } = resolveSelectedAndActiveModel({
        ...params,
        sessionEntry: { modelProvider: message.provider, model: message.model },
      });
      if (
        resolveActiveFallbackState({
          selectedModelRef: selected.label,
          activeModelRef: active.label,
          config: params.config,
          state: entry,
        }).active
      ) {
        return { modelProvider: active.provider, model: active.model };
      }
    }
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
  }
  return undefined;
}
