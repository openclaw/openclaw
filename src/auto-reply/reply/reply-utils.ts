import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const DOCUMENTED_REASONING_STREAM_LEAK = "Reasoning:";
// Only inspect tiny control-like JSON blobs here. Larger JSON bodies are normal model output.
const NO_REPLY_JSON_SENTINEL_MAX_LENGTH = 200;

function isJsonWrappedNoReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > NO_REPLY_JSON_SENTINEL_MAX_LENGTH) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return false;
    }

    const keys = Object.keys(parsed);
    if (keys.length > 2) {
      return false;
    }

    return parsed.action === SILENT_REPLY_TOKEN;
  } catch {
    return false;
  }
}

function isDocumentedReasoningLeak(text: string): boolean {
  return text.trim() === DOCUMENTED_REASONING_STREAM_LEAK;
}

export function sanitizeOutboundText(text: string | undefined): string | null | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (text === "") {
    return text;
  }
  if (isJsonWrappedNoReply(text)) {
    return null;
  }
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return null;
  }
  if (isDocumentedReasoningLeak(text)) {
    return null;
  }

  return text;
}
