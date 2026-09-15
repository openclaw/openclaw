import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import type { ChatRunError } from "./run-lifecycle.ts";

function normalizeDiagnostic(text: string): string {
  return formatWebUiIconErrorText(text)
    .trim()
    .replace(/^(?:Error:|This turn did not run:|This turn ended before a reply:)\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Recognize diagnostic rows, not ordinary assistant text or partial output. */
export function readTranscriptRunError(message: unknown): string | null {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  if (!record || metadata?.truncated === true) {
    return null;
  }
  const customFailure = record.role === "custom" && record.customType === "run-failed-before-reply";
  const assistantFailure = record.role === "assistant" && record.stopReason === "error";
  if (!customFailure && !assistantFailure) {
    return null;
  }
  const content = normalizeMessage(message).content;
  if (content.some((block) => block.type !== "text")) {
    return null;
  }
  const text = extractTextCached(message)?.trim();
  if (!text) {
    return null;
  }
  const error = typeof record.errorMessage === "string" ? record.errorMessage : null;
  if (
    assistantFailure &&
    (error
      ? normalizeDiagnostic(text) !== normalizeDiagnostic(error)
      : !/^(?:⚠️?\s*)?Error:\s*/iu.test(text))
  ) {
    return null;
  }
  return redactToolDetail(text, { preservePaths: true });
}

/** Only the same owned diagnostic may move from composer to durable history. */
export function hasTranscriptRunError(messages: readonly unknown[], error: ChatRunError): boolean {
  if (!error.runId) {
    return false;
  }
  return messages.some((message) => {
    const identity = readSessionMessageIdentity(message);
    if (!identity?.id || identity.isImported || identity.runId !== error.runId) {
      return false;
    }
    const diagnostic = readTranscriptRunError(message);
    return (
      diagnostic !== null && normalizeDiagnostic(diagnostic) === normalizeDiagnostic(error.summary)
    );
  });
}
