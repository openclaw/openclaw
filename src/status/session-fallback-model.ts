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

type SessionFallbackParams = SessionFallbackSource & {
  selectedProvider: string;
  selectedModel: string;
  parseSelectedProvider?: boolean;
  config?: OpenClawConfig;
};

function resolveCompletedFallbackEntry(params: SessionFallbackParams) {
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
  return normalizeOptionalString(entry.fallbackNotice.selectedModel) === selectedLabel
    ? { entry, scope: params.sessionScope }
    : undefined;
}

function selectCompletedFallbackModel(
  params: SessionFallbackParams,
  entry: InternalSessionEntry,
  terminalModel: SessionTerminalModel | null | undefined,
): SessionTerminalModel | undefined {
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

/** Present prepared terminal facts without opening storage. */
export function readSessionFallbackModel(
  params: SessionFallbackParams & { terminalModel: SessionTerminalModel | null },
): SessionTerminalModel | undefined {
  const completed = resolveCompletedFallbackEntry(params);
  return completed
    ? selectCompletedFallbackModel(params, completed.entry, params.terminalModel)
    : undefined;
}

/** Read terminal facts through the retained asynchronous history owner. */
export async function readSessionFallbackModelAsync(
  params: SessionFallbackParams,
): Promise<SessionTerminalModel | undefined> {
  const completed = resolveCompletedFallbackEntry(params);
  if (!completed) {
    return undefined;
  }
  const terminalModel = await readSessionTerminalFallbackModelAsync({
    sessionEntry: completed.entry,
    sessionScope: completed.scope,
  });
  return selectCompletedFallbackModel(params, completed.entry, terminalModel);
}

async function readSessionTerminalFallbackModelAsync(params: {
  sessionEntry: InternalSessionEntry;
  sessionScope: NonNullable<SessionFallbackSource["sessionScope"]>;
}) {
  const { readSessionTranscriptBoundedMessageTailPageAsync } =
    await import("../gateway/session-transcript-readers.js");
  try {
    const page = await readSessionTranscriptBoundedMessageTailPageAsync(
      { ...params.sessionScope, sessionId: params.sessionEntry.sessionId },
      { maxBytes: 256 * 1024, maxMessages: 1, offset: 0, readOnly: true },
    );
    return selectSessionTerminalFallbackModel(params.sessionEntry, page.events[0]?.event);
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
    return selectSessionTerminalFallbackModel(entry, page.events[0]?.event);
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

/** Durable and memory readers apply the same terminal-run selection to a bounded tail. */
export function selectSessionTerminalFallbackModel(
  entry: InternalSessionEntry,
  event: unknown,
): SessionTerminalModel | undefined {
  const message = asOptionalRecord(asOptionalRecord(event)?.message);
  if (
    (message?.stopReason === "stop" || message?.stopReason === "length") &&
    readSessionTranscriptRunId(message) === entry.lastRunId &&
    projectSessionDisplayMessage(message)?.role === "assistant" &&
    typeof message.provider === "string" &&
    typeof message.model === "string"
  ) {
    return { modelProvider: message.provider, model: message.model };
  }
  return undefined;
}
