import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { safeParseJson, safeParseJsonRecord } from "@openclaw/normalization-core";
import {
  asNullableObjectRecord as readRecord,
  asNullableRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { unwrapToolCallForDisplay } from "../../../../src/agents/tool-display-call.js";
import {
  extractCanvasFromDetails,
  extractCanvasFromText,
} from "../../../../src/chat/canvas-render.js";
import {
  isToolCallContentType,
  isToolErrorOutput,
  readToolErrorFlag,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import { readBrowserTabTarget } from "../../components/browser/browser-target.ts";
import type { ToolCard, ToolCardOutcome, ToolOutputMetadata } from "./chat-types.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { readLiveDiffStat } from "./tool-call-diff.ts";
import { readPreparedActivity } from "./tool-call-grouping.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;
export type CanvasToolPreview = Extract<ToolPreview, { kind: "canvas" }>;

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  return (
    readNonBlankString(message.messageId) ??
    readNonBlankString(asNullableRecord(message["__openclaw"])?.id)
  );
}

function readToolOutputMetadata(value: unknown): ToolOutputMetadata | undefined {
  const metadata = asNullableRecord(asNullableRecord(value)?.["__openclaw"]);
  const output = asNullableRecord(metadata?.toolOutput);
  return (output?.source === "provider-response" || output?.source === "execution") &&
    output.modelInput === "unverified"
    ? {
        source: output.source,
        modelInput: output.modelInput,
        ...(output.outcome === "unknown" ? { outcome: "unknown" as const } : {}),
        ...(output.captureTruncated === true ? { captureTruncated: true as const } : {}),
      }
    : undefined;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry): entry is Record<string, unknown> => readRecord(entry) !== null);
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[")
    ? (safeParseJson(trimmed) ?? value)
    : value;
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      const text = readRecord(entry)?.text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function readToolExitCode(...values: unknown[]): number | undefined {
  for (const value of values) {
    const record = readRecord(value);
    const exitCode = record?.exitCode ?? record?.exit_code;
    if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
      return exitCode;
    }
  }
  return undefined;
}

// Symbol metadata follows display spreads without exposing result payloads in serialization.
const recordedToolCardOutcome = Symbol("recordedToolCardOutcome");
type RecordedToolCard = ToolCard & { [recordedToolCardOutcome]?: ToolCard };

export function isToolCardSkipped(input: RecordedToolCard): boolean {
  const card = input[recordedToolCardOutcome] ?? input;
  if (card.activity) {
    return card.activity.status === "skipped";
  }
  const details = readRecord(card.details);
  return (
    (card.live !== true || card.completed === true) &&
    details?.status === "skipped" &&
    details.deniedReason === "steering"
  );
}

export function isToolCardError(input: RecordedToolCard): boolean {
  const card = input[recordedToolCardOutcome] ?? input;
  if (isToolCardSkipped(card)) {
    return false;
  }
  if (card.activity) {
    return card.activity.status === "failed";
  }
  // Progress can contain error-shaped text; only a result may imply failure.
  const canInferFailure = card.live !== true || card.completed === true;
  return card.isError ?? (canInferFailure && isToolErrorOutput(card.outputText));
}

export function resolveToolCardOutcome(
  input: RecordedToolCard,
  runActive: boolean | undefined,
): ToolCardOutcome {
  const card = input[recordedToolCardOutcome] ?? input;
  if (isToolCardSkipped(card)) {
    return "skipped";
  }
  // A response receipt without a native outcome must not become a success
  // merely because history grouped it into a completed tool row.
  if (card.toolOutput?.outcome === "unknown") {
    return isToolCardError(card) ? "failed" : "unknown";
  }
  if (card.activity?.unpairedCall) {
    return runActive === true && card.live === true && card.completed !== true
      ? "running"
      : "unrecorded";
  }
  if (card.activity) {
    const { status, phase } = card.activity;
    if (status === "failed" || status === "blocked") {
      return status;
    }
    if (status === "completed") {
      return "succeeded";
    }
    return runActive === true &&
      card.live === true &&
      (status === "running" || (phase !== "end" && card.completed !== true))
      ? "running"
      : "unknown";
  }
  if (isToolCardError(card)) {
    return "failed";
  }
  if (runActive === true && card.live === true && card.completed !== true) {
    return "running";
  }
  if (card.completed === true || (card.live !== true && card.outputText !== undefined)) {
    return "succeeded";
  }
  return "unrecorded";
}

/** Preserve view incompleteness when adapting card outcomes to shared activity. */
export function projectToolCardActivityOutcome(
  outcome: ToolCardOutcome,
): Pick<NonNullable<ToolCard["activity"]>, "status" | "unpairedCall"> {
  return outcome === "unrecorded"
    ? { unpairedCall: true }
    : {
        status: outcome === "succeeded" ? "completed" : outcome === "unknown" ? undefined : outcome,
      };
}

export function extractToolPreview(outputText: string | undefined): CanvasToolPreview | undefined {
  const preview = extractCanvasFromText(outputText);
  return preview?.surface === "assistant_message"
    ? { ...preview, surface: "assistant_message" }
    : undefined;
}

function extractToolPresentation(
  details: unknown,
  text: string | undefined,
  browserToolName: string,
): Pick<ToolCard, "preview" | "browserTab"> {
  const preview = extractCanvasFromDetails(details);
  const canvas =
    preview?.surface === "assistant_message"
      ? { ...preview, surface: "assistant_message" }
      : extractToolPreview(text);
  if (canvas) {
    return { preview: { ...canvas, surface: "assistant_message" } };
  }
  const tab = asNullableRecord(asNullableRecord(details)?.browserTab);
  const target = readBrowserTabTarget(tab);
  if (browserToolName !== "browser" || !tab || !target) {
    return {};
  }
  const url = typeof tab.url === "string" ? truncateUtf16Safe(tab.url, 2_048) : "";
  return {
    browserTab: target,
    preview: isHttpUrl(url)
      ? {
          kind: "browser-tab",
          ...target,
          url,
          ...(typeof tab.title === "string" ? { title: truncateUtf16Safe(tab.title, 512) } : {}),
        }
      : undefined,
  };
}

function resolveToolCallId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return (
    resolveToolUseId(item) ??
    normalizeOptionalString(item.callId) ??
    normalizeOptionalString(message.toolCallId) ??
    normalizeOptionalString(message.tool_call_id) ??
    normalizeOptionalString(message.toolUseId) ??
    normalizeOptionalString(message.tool_use_id)
  );
}

function resolveToolName(item: Record<string, unknown>, message: Record<string, unknown>): string {
  return (
    normalizeOptionalString(item.name) ??
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    "tool"
  );
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  return JSON.stringify(args, null, 2);
}

/** Rendering only: extraction and result retrieval retain the original card. */
export function resolveToolCardDisplay(card: ToolCard): ToolCard {
  const call = unwrapToolCallForDisplay(card);
  return call === card ? card : { ...card, ...call, inputText: serializeToolInput(call.args) };
}

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const withoutConnector = normalized.replace(/^with\s+/i, "").trim();
  return withoutConnector || normalized;
}

function collapsedToolTextKey(value: string | undefined): string | undefined {
  return formatCollapsedToolSummaryText(value)
    ?.toLowerCase()
    .replace(/[\s._-]+/g, "");
}

export function formatDistinctCollapsedToolSummaryText(
  value: string | undefined,
  label: string | undefined,
): string | undefined {
  const displayValue = formatCollapsedToolSummaryText(value);
  if (!displayValue) {
    return undefined;
  }
  const valueKey = collapsedToolTextKey(displayValue);
  const labelKey = collapsedToolTextKey(label);
  return valueKey && labelKey && valueKey === labelKey ? undefined : displayValue;
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  const normalized = formatCollapsedToolSummaryText(value);
  if (!normalized) {
    return undefined;
  }
  return truncateUtf16Safe(normalized, 120);
}

const TOOL_ARGUMENT_PREVIEW_KEYS = [
  "message",
  "prompt",
  "task",
  "query",
  "text",
  "description",
] as const;

/** First meaningful user-authored line for compact generic tool rows. */
export function resolveCollapsedToolArgumentPreview(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  for (const key of TOOL_ARGUMENT_PREVIEW_KEYS) {
    const value = args[key];
    if (typeof value !== "string") {
      continue;
    }
    const preview = formatCollapsedToolPreviewText(value.trimStart().split(/[\r\n]/, 1)[0]);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

let nextPreviewRevision = 0;

export function isToolCallContentBlock(item: {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
}): boolean {
  return (
    isToolCallContentType(item.type) ||
    (typeof item.name === "string" &&
      (item.arguments != null || item.args != null || item.input != null))
  );
}

const envelopeCardsByBlock = new WeakMap<object, WeakMap<object, ToolCard>>();

function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const catalogMetadata = asNullableRecord(m["__openclaw"]);
  const catalogSource = catalogMetadata?.catalogSource === true;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const isStandaloneToolMessage =
    isToolResultMessage(message) ||
    role === "tool" ||
    role === "function" ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const isLiveToolStream = m["__openclawToolStreamLive"] === true;
  const liveDiffStat = readLiveDiffStat(m["__openclawToolStreamDiffStat"]);
  const cards: ToolCard[] = [];
  const blockCards = new WeakMap<object, ToolCard>();
  if (message && typeof message === "object") {
    envelopeCardsByBlock.set(message, blockCards);
  }
  const fallbackMatchedCards = new WeakSet<ToolCard>();
  const transcriptMessageId = resolveTranscriptMessageId(m);
  const messageRunId = readSessionMessageIdentity(m)?.runId ?? readNonBlankString(m.runId);
  const readResult = (
    item: Record<string, unknown>,
    browserToolName: string,
    standalone = false,
  ) => {
    const text = extractToolText(item);
    const details = item.details ?? m.details;
    const metadata = asNullableRecord(item["__openclaw"]);
    // Recorded catalog prose cannot establish an execution outcome.
    const isError =
      readToolErrorFlag(item) ?? messageIsError ?? (catalogSource ? false : undefined);
    const exitCode = readToolExitCode(
      item,
      details,
      !catalogSource && text ? safeParseJsonRecord(text.trim()) : undefined,
      standalone ? undefined : m,
    );
    return {
      outputText: text,
      ...(catalogSource && metadata?.catalogTruncated === true ? { catalogTruncated: true } : {}),
      resultMessageId: catalogSource
        ? undefined
        : !standalone && metadata && Object.hasOwn(metadata, "id")
          ? readNonBlankString(metadata.id)
          : transcriptMessageId,
      outputTruncated:
        (metadata && Object.hasOwn(metadata, "truncated")
          ? metadata
          : asNullableRecord(m["__openclaw"])
        )?.truncated === true,
      toolOutput: readToolOutputMetadata(item) ?? readToolOutputMetadata(m),
      ...(details !== undefined ? { details } : {}),
      ...(isError !== undefined ? { isError } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(catalogSource ? {} : extractToolPresentation(details, text, browserToolName)),
    };
  };

  for (let index = 0; index < content.length; index++) {
    const item = content[index] ?? {};
    const isCall = isToolCallContentBlock(item);
    if (!isCall && !isToolResultContentType(item.type)) {
      continue;
    }
    const runId = readNonBlankString(item.runId) ?? messageRunId;
    const parentToolCallId = readNonBlankString(item.parentToolCallId);
    const callId = resolveToolCallId(item, m);
    const name = resolveToolName(item, m);
    const identity = {
      id: callId ?? `${name}:${index}`,
      ...(callId ? { callId } : {}),
      ...(runId ? { runId } : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
      name,
      messageId: transcriptMessageId,
    };
    const details = item.details ?? m.details;
    if (isCall) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      cards.push({
        ...identity,
        args,
        inputText: serializeToolInput(args),
        ...(details !== undefined ? { details } : {}),
        ...(isLiveToolStream
          ? {
              live: true,
              completed:
                m["__openclawToolStreamResultReceived"] === true ||
                m["__openclawToolStreamItemEnded"] === true,
            }
          : {}),
        ...(liveDiffStat ? { liveDiffStat } : {}),
      });
      blockCards.set(item, cards.at(-1)!);
      continue;
    }

    const existing =
      cards.find((card) => card.id === identity.id) ??
      cards.find(
        (card) =>
          // Same-name fallback belongs to legacy blocks missing an explicit identity.
          (!callId || !card.callId) &&
          card.name === name &&
          card.outputText === undefined &&
          !fallbackMatchedCards.has(card),
      );
    // Browser previews trigger I/O. Nested content cannot override its tool
    // envelope, and a paired result cannot override the authoritative call.
    const envelopeName = isStandaloneToolMessage ? resolveToolName({}, m) : undefined;
    const browserToolName =
      envelopeName && envelopeName !== "browser"
        ? envelopeName
        : (existing?.name ?? envelopeName ?? name);
    const result = readResult(item, browserToolName);
    if (existing) {
      blockCards.set(item, existing);
      fallbackMatchedCards.add(existing);
      existing.callId ??= callId;
      existing.runId ??= runId;
      existing.parentToolCallId ??= parentToolCallId;
      // Live tool-stream messages emit a toolresult block for partial
      // `update` output too; completion there is owned by the stream's
      // terminal markers (set at card creation), not block presence —
      // otherwise a running tool flips to "succeeded" mid-execution.
      if (!isLiveToolStream) {
        existing.completed = true;
      }
      Object.assign(existing, result, {
        preview: result.preview,
        browserTab: result.browserTab,
      });
      continue;
    }
    cards.push({
      ...identity,
      completed: true,
      ...result,
    });
    blockCards.set(item, cards.at(-1)!);
  }

  if (isStandaloneToolMessage && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const callId = resolveToolCallId({}, m);
    cards.push({
      id: callId ?? `${resolveToolName({}, m)}:0`,
      ...(callId ? { callId } : {}),
      ...(messageRunId ? { runId: messageRunId } : {}),
      name,
      completed: isToolResultMessage(message) || role === "tool" || role === "function",
      messageId: transcriptMessageId,
      ...readResult(m, name, true),
    });
  }

  const activityByCall = new Map(
    readPreparedActivity(message)
      .filter((item) => !item.suppressChannelProgress)
      .map((item) => [item.toolCallId ?? item.itemId, item]),
  );
  let revision: number | undefined;
  for (const [index, card] of cards.entries()) {
    if (catalogSource && catalogMetadata?.catalogTruncated === true) {
      card.catalogTruncated = true;
    }
    const activity = card.callId ? activityByCall.get(card.callId) : undefined;
    if (activity) {
      card.activity = activity;
    }
    if (!card.browserTab || card.callId || card.messageId) {
      continue;
    }
    revision ??= ++nextPreviewRevision;
    card.previewRevision = `${revision}:${index}`;
  }
  return cards;
}

const toolCardsByMessage = new WeakMap<object, { content: unknown; cards: ToolCard[] }>();
const toolCardEnvelopes = new WeakMap<object, object>();

/** Immutable presentation fragments retain pairing context without copying output blocks. */
export function rememberToolCardEnvelope(fragment: object, envelope: unknown): void {
  if (envelope && typeof envelope === "object") {
    toolCardEnvelopes.set(fragment, toolCardEnvelopes.get(envelope) ?? envelope);
  }
}

function projectEnvelopeCards(message: object): ToolCard[] | undefined {
  const envelope = toolCardEnvelopes.get(message);
  if (!envelope) {
    return undefined;
  }
  extractToolCardsCached(envelope);
  const recorded = envelopeCardsByBlock.get(envelope);
  const content = normalizeContent(asNullableRecord(message)?.content);
  const seen = new Set<ToolCard>();
  return content.flatMap((block) => {
    const paired = recorded?.get(block);
    if (!paired || seen.has(paired)) {
      return [];
    }
    seen.add(paired);
    const hasResult = content.some(
      (item) => isToolResultContentType(item.type) && recorded?.get(item) === paired,
    );
    if (hasResult) {
      return [paired];
    }
    // Extract calls independently: legacy fragment-local pairing can differ
    // from the recorded envelope when another call precedes this stretch.
    const [card] = extractToolCards({ ...asNullableRecord(message), content: [block] });
    // The call carries its recorded outcome, but output/preview stays at the
    // result's original position rather than appearing twice.
    return [
      {
        ...card,
        id: paired.id,
        callId: paired.callId,
        name: paired.name,
        [recordedToolCardOutcome]: paired,
        completed: paired.completed,
        isError: isToolCardError(paired),
        exitCode: paired.exitCode,
        toolOutput: paired.toolOutput,
      },
    ];
  });
}

export function extractToolCardsCached(message: unknown): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCards(message);
  }
  const content = asNullableRecord(message)?.content;
  const cached = toolCardsByMessage.get(message);
  if (cached && cached.content === content) {
    return cached.cards;
  }
  const cards = projectEnvelopeCards(message) ?? extractToolCards(message);
  toolCardsByMessage.set(message, { content, cards });
  return cards;
}

const toolCardsByBlock = new WeakMap<object, WeakMap<object, ToolCard[]>>();

// Messages and blocks are immutable snapshots, including live stream updates.
// Key block projections by their source identities, never a temporary envelope.
export function extractToolBlockCardsCached(
  message: Record<string, unknown>,
  block: Record<string, unknown>,
): ToolCard[] {
  let byBlock = toolCardsByBlock.get(message);
  const cached = byBlock?.get(block);
  if (cached) {
    return cached;
  }
  const fragment = { ...message, content: [block] };
  rememberToolCardEnvelope(fragment, message);
  // A result projection uses the recorded card unchanged. Re-extracting its
  // payload would repeat preview preparation (including browser preview I/O).
  const envelope = toolCardEnvelopes.get(message) ?? message;
  extractToolCardsCached(envelope);
  const recorded = isToolResultContentType(block.type)
    ? envelopeCardsByBlock.get(envelope)?.get(block)
    : undefined;
  const cards = recorded
    ? [recorded]
    : (projectEnvelopeCards(fragment) ?? extractToolCards(fragment));
  if (!byBlock) {
    byBlock = new WeakMap();
    toolCardsByBlock.set(message, byBlock);
  }
  byBlock.set(block, cards);
  return cards;
}
