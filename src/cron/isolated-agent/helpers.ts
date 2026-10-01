/** Normalizes isolated cron run output into summaries, delivery payloads, and error state. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { isExecLikeToolName } from "../../agents/tool-error-summary.js";
import { isHeartbeatAcknowledgementText } from "../../auto-reply/heartbeat.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { isSilentReplyPayloadText } from "../../auto-reply/tokens.js";
import { truncateUtf16Safe } from "../../utils.js";

type DeliveryPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData" | "isError"
>;

/** Normalized cron run payload state used for summaries, delivery, and failure classification. */
type CronPayloadOutcome = {
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayload?: DeliveryPayload;
  deliveryPayloads: DeliveryPayload[];
  deliveryDisposition:
    | { kind: "visible" }
    | { kind: "heartbeat"; controlOnly: boolean }
    | { kind: "empty" };
  deliveryPayloadHasStructuredContent: boolean;
  hasFatalErrorPayload: boolean;
  hasFatalStructuredErrorPayload: boolean;
  embeddedRunError?: string;
  pendingPresentationWarningError?: string;
};

type CronFailureSignal = {
  kind?: string;
  source?: string;
  toolName?: string;
  code?: string;
  message?: string;
  fatalForCron?: boolean;
};

function formatCronFailureSignal(signal: CronFailureSignal & { message: string }): string {
  const kind = normalizeOptionalString(signal.kind) ?? "run";
  const code = normalizeOptionalString(signal.code);
  const source = normalizeOptionalString(signal.toolName) ?? normalizeOptionalString(signal.source);
  return `cron classifier: ${kind} failure${source ? ` from ${source}` : ""}${
    code ? ` (${code})` : ""
  }: ${signal.message}`;
}

function formatCronRunLevelError(error: unknown): string | undefined {
  const direct = normalizeOptionalString(error);
  if (direct) {
    return `cron isolated run failed: ${direct}`;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { message?: unknown; kind?: unknown };
  const detail = normalizeOptionalString(record.message) ?? normalizeOptionalString(record.kind);
  return detail ? `cron isolated run failed: ${detail}` : "cron isolated run failed";
}

/** Picks a bounded cron run summary from plain text output. */
export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

/** Picks the last non-empty payload text while ignoring terminal error payloads first. */
export function pickLastNonEmptyTextFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  const successful = payloads
    .findLast((payload) => !payload?.isError && payload?.text?.trim())
    ?.text?.trim();
  if (successful) {
    return successful;
  }
  return payloads
    .findLast((payload) => !isNonTerminalToolErrorWarning(payload) && payload?.text?.trim())
    ?.text?.trim();
}

function isDeliverablePayload(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return hasOutboundReplyContent(payload, { trimText: true });
}

function payloadHasStructuredDeliveryContent(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return (
    payload.mediaUrl !== undefined ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    (payload.presentation?.blocks?.length ?? 0) > 0 ||
    (payload.interactive?.blocks?.length ?? 0) > 0 ||
    Object.keys(payload.channelData ?? {}).length > 0
  );
}

function payloadHasNonTextDeliveryContent(payload: DeliveryPayload): boolean {
  return hasOutboundReplyContent({ ...payload, text: undefined }, { trimText: true });
}

function resolveCronDeliveryPayloads(params: {
  payloads: DeliveryPayload[];
  finalAssistantVisibleText?: string;
}): Pick<CronPayloadOutcome, "deliveryPayloads" | "deliveryDisposition"> {
  if (params.payloads.length === 0) {
    return { deliveryPayloads: [], deliveryDisposition: { kind: "empty" } };
  }
  // Structured output is always visible, even when a sibling text payload is
  // an acknowledgement. Only the payload owner can safely preserve that batch.
  const hasNonTextContent = params.payloads.some(payloadHasNonTextDeliveryContent);
  const terminalText = params.finalAssistantVisibleText ?? params.payloads.at(-1)?.text;
  if (!hasNonTextContent && isHeartbeatAcknowledgementText(terminalText)) {
    const controlOnly = params.payloads.every((payload) =>
      isHeartbeatAcknowledgementText(payload.text, 0),
    );
    return {
      deliveryPayloads: params.payloads,
      deliveryDisposition: { kind: "heartbeat", controlOnly },
    };
  }
  return {
    // Earlier control acknowledgements cannot become visible siblings of a
    // later result or fail before that result reaches recipient custody.
    deliveryPayloads: params.payloads.filter(
      (payload) =>
        payloadHasNonTextDeliveryContent(payload) || !isHeartbeatAcknowledgementText(payload.text),
    ),
    deliveryDisposition: { kind: "visible" },
  };
}

function readToolErrorWarningName(payload: object | undefined): string | undefined {
  return normalizeOptionalLowercaseString(
    payload && getReplyPayloadMetadata(payload)?.toolErrorWarning?.toolName,
  );
}

function isNonTerminalToolErrorWarning(payload: object | undefined): boolean {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.nonTerminalToolErrorWarning);
}

function isSuccessfulCronPayload(payload: DeliveryPayload | undefined): boolean {
  return (
    payload?.isError !== true &&
    (isDeliverablePayload(payload) || payloadHasStructuredDeliveryContent(payload))
  );
}

/** Resolves summary, output text, delivery payloads, and fatal-error state from cron run output. */
export function resolveCronPayloadOutcome(params: {
  payloads: DeliveryPayload[];
  runLevelError?: unknown;
  failureSignal?: CronFailureSignal | undefined;
  finalAssistantVisibleText?: string | undefined;
  preferFinalAssistantVisibleText?: boolean;
}): CronPayloadOutcome {
  const fallbackOutputText = pickLastNonEmptyTextFromPayloads(params.payloads);
  const fallbackSummary = pickSummaryFromOutput(fallbackOutputText);
  const deliveryPayload =
    params.payloads.findLast((payload) => !payload?.isError && isDeliverablePayload(payload)) ??
    params.payloads.findLast(isDeliverablePayload);
  const successfulDeliveryPayloads = params.payloads.filter(
    (payload) => payload != null && payload.isError !== true && isDeliverablePayload(payload),
  );
  const selectedDeliveryPayloads = successfulDeliveryPayloads.length
    ? successfulDeliveryPayloads
    : deliveryPayload
      ? [deliveryPayload]
      : [];
  const deliveryPayloadHasStructuredContent = payloadHasStructuredDeliveryContent(deliveryPayload);
  const lastErrorPayloadIndex = params.payloads.findLastIndex(
    (payload) => payload?.isError === true,
  );
  const lastTextErrorPayload = params.payloads.findLast(
    (payload) => payload?.isError === true && Boolean(payload?.text?.trim()),
  );
  const lastErrorPayloadText = lastTextErrorPayload?.text?.trim();
  const errorPayloads = params.payloads.filter((payload) => payload?.isError === true);
  const finalText = normalizeOptionalString(params.finalAssistantVisibleText);
  const normalizedFinalAssistantVisibleText =
    finalText && !isSilentReplyPayloadText(finalText) ? finalText : undefined;
  const hasSuccessfulPayloadAfterLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex >= 0 &&
    params.payloads.slice(lastErrorPayloadIndex + 1).some(isSuccessfulCronPayload);
  const hasSuccessfulPayloadBeforeLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex > 0 &&
    params.payloads.slice(0, lastErrorPayloadIndex).some(isSuccessfulCronPayload);
  const lastErrorPayload =
    lastErrorPayloadIndex >= 0 ? params.payloads[lastErrorPayloadIndex] : undefined;
  const hasRecoveringTerminalOutput =
    normalizedFinalAssistantVisibleText !== undefined ||
    hasSuccessfulPayloadAfterLastError ||
    hasSuccessfulPayloadBeforeLastError;
  // Only genuinely visible terminal text can recover preceding tool warnings;
  // silent control replies must leave the error fatal for scheduler alerting.
  const canRecoverToolWarning =
    !params.runLevelError && params.failureSignal?.fatalForCron !== true;
  const hasNonTerminalToolErrorWarning =
    canRecoverToolWarning &&
    hasRecoveringTerminalOutput &&
    isNonTerminalToolErrorWarning(lastErrorPayload);
  const hasPendingPresentationWarning =
    canRecoverToolWarning &&
    lastErrorPayloadIndex >= 0 &&
    readToolErrorWarningName(lastTextErrorPayload) === "message" &&
    (normalizedFinalAssistantVisibleText !== undefined || hasSuccessfulPayloadBeforeLastError);
  const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) =>
    payloadHasStructuredDeliveryContent(payload),
  );
  const hasRecoveredToolWarning =
    canRecoverToolWarning &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasStructuredDeliveryPayloads &&
    errorPayloads.length > 0 &&
    errorPayloads.every((payload) => isExecLikeToolName(readToolErrorWarningName(payload) ?? ""));
  // Structured error payloads stay fatal unless later successful output or a
  // known non-terminal warning proves the agent recovered.
  const hasFatalStructuredErrorPayload =
    errorPayloads.length > 0 &&
    !hasSuccessfulPayloadAfterLastError &&
    !hasPendingPresentationWarning &&
    !hasNonTerminalToolErrorWarning &&
    !hasRecoveredToolWarning;
  // Fatal structured errors own the final delivery payload unless later output
  // proves recovery; otherwise cron would announce stale partial success text.
  // Keep structured/media announce payloads intact. Only collapse purely textual
  // cron announce output to the final assistant-visible answer.
  // A final assistant answer can replace textual warning payloads, but never
  // structured/media payloads that carry the actual delivery content.
  const shouldUseFinalAssistantVisibleText =
    (params.preferFinalAssistantVisibleText === true || hasRecoveredToolWarning) &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasFatalStructuredErrorPayload &&
    !hasStructuredDeliveryPayloads;
  const summary = shouldUseFinalAssistantVisibleText
    ? (pickSummaryFromOutput(normalizedFinalAssistantVisibleText) ?? fallbackSummary)
    : fallbackSummary;
  const outputText = shouldUseFinalAssistantVisibleText
    ? normalizedFinalAssistantVisibleText
    : fallbackOutputText;
  const synthesizedText = normalizeOptionalString(outputText) ?? normalizeOptionalString(summary);
  const finalDeliveryPayload = shouldUseFinalAssistantVisibleText
    ? { text: normalizedFinalAssistantVisibleText }
    : undefined;
  if (
    finalDeliveryPayload &&
    deliveryPayload &&
    deliveryPayload.isError !== true &&
    deliveryPayload.text === normalizedFinalAssistantVisibleText
  ) {
    // A replacement or assembled answer must not inherit another payload's
    // speech. This fresh text projection never inherits transcript or custody ownership.
    const tts = getReplyPayloadMetadata(deliveryPayload)?.tts;
    if (tts) {
      setReplyPayloadMetadata(finalDeliveryPayload, { tts });
    }
  }
  const resolvedDeliveryPayloads = finalDeliveryPayload
    ? [finalDeliveryPayload]
    : selectedDeliveryPayloads.length > 0
      ? selectedDeliveryPayloads
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];
  // Only explicit fatal signals become cron failures; ordinary tool warnings
  // still need payload/output evidence before failing the run.
  const failureMessage = normalizeOptionalString(params.failureSignal?.message);
  const failureSignal =
    params.failureSignal?.fatalForCron === true && failureMessage
      ? { ...params.failureSignal, message: failureMessage }
      : undefined;
  const runLevelError = formatCronRunLevelError(params.runLevelError);
  const hasFatalErrorPayload =
    hasFatalStructuredErrorPayload || failureSignal !== undefined || runLevelError !== undefined;
  const structuredErrorText = hasFatalStructuredErrorPayload
    ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
    : undefined;
  const fatalDeliveryText = structuredErrorText ?? failureSignal?.message ?? runLevelError;
  const fatalDeliveryPayload = fatalDeliveryText
    ? ({ text: fatalDeliveryText, isError: true } satisfies DeliveryPayload)
    : undefined;
  const delivery = fatalDeliveryPayload
    ? {
        deliveryPayloads: [fatalDeliveryPayload],
        deliveryDisposition: { kind: "visible" } as const,
      }
    : resolveCronDeliveryPayloads({
        payloads: resolvedDeliveryPayloads,
        finalAssistantVisibleText: normalizedFinalAssistantVisibleText,
      });
  return {
    summary: fatalDeliveryText ? (pickSummaryFromOutput(fatalDeliveryText) ?? summary) : summary,
    outputText: fatalDeliveryText ?? outputText,
    synthesizedText: fatalDeliveryText ?? synthesizedText,
    deliveryPayload: fatalDeliveryPayload ?? deliveryPayload,
    deliveryPayloads: delivery.deliveryPayloads,
    deliveryDisposition: delivery.deliveryDisposition,
    deliveryPayloadHasStructuredContent: fatalDeliveryPayload
      ? false
      : deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    hasFatalStructuredErrorPayload,
    embeddedRunError: structuredErrorText
      ? structuredErrorText
      : failureSignal
        ? formatCronFailureSignal(failureSignal)
        : runLevelError,
    pendingPresentationWarningError: hasPendingPresentationWarning
      ? lastErrorPayloadText
      : undefined,
  };
}
