import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { readSessionTranscriptBoundedMessageTailPage } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";

type SessionTerminalModel = { modelProvider: string; model: string };
type SessionFallbackSource = {
  sessionEntry?: InternalSessionEntry;
  sessionScope?: Pick<SessionTranscriptReadScope, "agentId" | "sessionKey" | "storePath">;
};

/** Reads a terminal fallback model only when the run, selection, and notice agree. */
export function readSessionFallbackModel(
  params: SessionFallbackSource & {
    selectedProvider: string;
    selectedModel: string;
    parseSelectedProvider?: boolean;
    config?: OpenClawConfig;
    /** Null is a prepared absence; only undefined permits a synchronous read. */
    terminalModel?: SessionTerminalModel | null;
  },
): SessionTerminalModel | undefined {
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
  const terminalModel =
    params.terminalModel === undefined
      ? readSessionTerminalFallbackModel(params)
      : params.terminalModel;
  if (!terminalModel) {
    return undefined;
  }
  const { selected, active } = resolveSelectedAndActiveModel({
    ...params,
    sessionEntry: terminalModel,
  });
  return resolveActiveFallbackState({
    selectedModelRef: selected.label,
    activeModelRef: active.label,
    config: params.config,
    state: entry,
  }).active
    ? { modelProvider: active.provider, model: active.model }
    : undefined;
}

/** Storage readers prepare terminal facts; the host retains runtime alias policy. */
export function readSessionTerminalFallbackModel(
  params: SessionFallbackSource,
): SessionTerminalModel | undefined {
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
  try {
    const page = readSessionTranscriptBoundedMessageTailPage(
      { ...params.sessionScope, sessionId: entry.sessionId },
      { maxBytes: 256 * 1024, maxMessages: 1, offset: 0, readOnly: true },
    );
    const message = asOptionalRecord(asOptionalRecord(page.events[0]?.event)?.message);
    if (
      (message?.stopReason === "stop" || message?.stopReason === "length") &&
      readSessionTranscriptRunId(message) === entry.lastRunId &&
      projectSessionDisplayMessage(message)?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { modelProvider: message.provider, model: message.model };
    }
  } catch (error) {
    if (
      !isSessionTranscriptProjectionUnavailableError(error) &&
      !(error instanceof SessionTranscriptStorageUnavailableError)
    ) {
      throw error;
    }
  }
  return undefined;
}
