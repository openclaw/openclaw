// Control UI chat module implements tool cards behavior.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import { t } from "../../i18n/index.ts";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./role-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

type ToolCardKind = "tool" | "command" | "proof" | "artifact";
type ToolCardStatus = "passed" | "failed" | "running" | "blocked" | "unknown";

type ToolCardFact = {
  label: string;
  value: string;
};

type ToolCardPresentation = {
  kind: ToolCardKind;
  eyebrow: string;
  outputLabel: string;
  status?: ToolCardStatus;
  titleOverride?: string;
  detail?: string;
  facts: ToolCardFact[];
  previewText?: string;
};

type FullMessageRequest = NonNullable<SidebarContent["fullMessageRequest"]>;

function resolveCanvasPreviewSandbox(preview: ToolPreview): string {
  return resolveEmbedSandbox(preview.kind === "canvas" ? "scripts" : "scripts");
}

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.messageId === "string" && message.messageId.trim()) {
    return message.messageId;
  }
  const openClawMeta = message["__openclaw"];
  const transcriptMeta =
    openClawMeta && typeof openClawMeta === "object" && !Array.isArray(openClawMeta)
      ? (openClawMeta as Record<string, unknown>)
      : null;
  return typeof transcriptMeta?.id === "string" && transcriptMeta.id.trim()
    ? transcriptMeta.id
    : undefined;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
  );
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
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
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}

export function isToolCardError(card: ToolCard): boolean {
  if (card.isError !== undefined) {
    return card.isError;
  }
  return isToolErrorOutput(card.outputText);
}

export function extractToolPreview(
  outputText: string | undefined,
  toolName: string | undefined,
): ToolCard["preview"] | undefined {
  return extractCanvasFromText(outputText, toolName);
}

function resolveToolCardId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  prefix = "tool",
): string {
  const explicitId =
    (typeof item.id === "string" && item.id.trim()) ||
    (typeof item.toolCallId === "string" && item.toolCallId.trim()) ||
    (typeof item.tool_call_id === "string" && item.tool_call_id.trim()) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    "";
  if (explicitId) {
    return `${prefix}:${explicitId}`;
  }
  const name =
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool";
  return `${prefix}:${name}:${index}`;
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint") {
      return String(args);
    }
    if (typeof args === "symbol") {
      return args.description ? `Symbol(${args.description})` : "Symbol()";
    }
    return Object.prototype.toString.call(args);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  const trimmed = text?.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed)) {
      return { items: parsed };
    }
  } catch {}
  return undefined;
}

function firstStringFromRecord(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumberFromRecord(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function firstBooleanFromRecord(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function normalizeStatus(value: string | undefined): ToolCardStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    ["success", "succeeded", "passed", "pass", "ok", "complete", "completed"].includes(normalized)
  ) {
    return "passed";
  }
  if (
    [
      "failure",
      "failed",
      "fail",
      "error",
      "errored",
      "cancelled",
      "canceled",
      "timeout",
      "timed_out",
    ].includes(normalized)
  ) {
    return "failed";
  }
  if (
    ["running", "queued", "pending", "in_progress", "in-progress", "started"].includes(normalized)
  ) {
    return "running";
  }
  if (["blocked", "needs_user_input", "needs-user-input"].includes(normalized)) {
    return "blocked";
  }
  return undefined;
}

function statusLabel(status: ToolCardStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "unknown":
      return "Status unknown";
  }
  return "Status unknown";
}

function statusFromEvidence(
  outputRecord: Record<string, unknown> | undefined,
): ToolCardStatus | undefined {
  const exitCode = firstNumberFromRecord(outputRecord, ["exitCode", "exit_code", "code"]);
  if (exitCode !== undefined) {
    return exitCode === 0 ? "passed" : "failed";
  }
  const success = firstBooleanFromRecord(outputRecord, ["ok", "success", "passed"]);
  if (success !== undefined) {
    return success ? "passed" : "failed";
  }
  const timedOut = firstBooleanFromRecord(outputRecord, ["timedOut", "timed_out", "timeout"]);
  if (timedOut === true) {
    return "failed";
  }
  const status = normalizeStatus(
    firstStringFromRecord(outputRecord, ["conclusion", "status", "state", "result"]),
  );
  if (status) {
    return status;
  }
  return undefined;
}

function pushFact(facts: ToolCardFact[], label: string, value: string | number | undefined) {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim();
  if (text) {
    facts.push({ label, value: text });
  }
}

function inferToolCardKind(params: {
  argsRecord?: Record<string, unknown>;
  command?: string;
  name: string;
  outputRecord?: Record<string, unknown>;
}): ToolCardKind {
  const toolName = params.name.toLowerCase();
  const output = params.outputRecord;
  if (
    firstStringFromRecord(output, [
      "artifactId",
      "artifact_id",
      "artifactPath",
      "artifact_path",
      "filePath",
      "file_path",
      "screenshotPath",
      "screenshot_path",
      "reportPath",
      "report_path",
      "path",
      "url",
    ]) ||
    Array.isArray(output?.artifacts) ||
    Array.isArray(output?.artifactPaths) ||
    Array.isArray(output?.artifact_paths) ||
    toolName.includes("artifact")
  ) {
    return "artifact";
  }
  const command = params.command?.trim() ?? "";
  if (
    firstStringFromRecord(output, [
      "workflow",
      "workflowName",
      "workflow_name",
      "runUrl",
      "run_url",
      "runId",
      "run_id",
      "headSha",
      "head_sha",
      "proofKind",
      "proof_kind",
    ]) ||
    /\b(pnpm\s+(test|check|tsgo|ui:smoke)|gh\s+(workflow|run)|workflow|proof|ci)\b/i.test(
      command,
    ) ||
    toolName.includes("proof") ||
    toolName.includes("github") ||
    toolName.includes("workflow")
  ) {
    return "proof";
  }
  if (
    command ||
    firstStringFromRecord(params.argsRecord, ["cmd", "command", "script"]) ||
    /(?:^|[._-])(exec|bash|shell|terminal|command|system\.run)(?:$|[._-])/.test(toolName)
  ) {
    return "command";
  }
  return "tool";
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  }
  return `${value}ms`;
}

function outputPreviewFromRecord(
  outputRecord: Record<string, unknown> | undefined,
): string | undefined {
  return firstStringFromRecord(outputRecord, [
    "summary",
    "evidence",
    "message",
    "stdout",
    "stderr",
    "output",
    "text",
    "log",
  ]);
}

function formatPayloadForSidebar(
  text: string | undefined,
  language: "json" | "text" = "text",
): string {
  if (!text?.trim()) {
    return "";
  }
  if (language === "json") {
    return `\`\`\`json
${text}
\`\`\``;
  }
  const formatted = formatToolOutputForSidebar(text);
  if (formatted.includes("```")) {
    return formatted;
  }
  return `\`\`\`text
${text}
\`\`\``;
}

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const withoutConnector = normalized.replace(/^with\s+/i, "").trim();
  return withoutConnector || normalized;
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  const normalized = formatCollapsedToolSummaryText(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 120);
}

function findFirstUnmatchedCard(
  cards: ToolCard[],
  id: string,
  name: string,
  fallbackMatchedCards: WeakSet<ToolCard>,
): ToolCard | undefined {
  let nameOnlyCandidate: ToolCard | undefined;
  for (const card of cards) {
    if (card.id === id) {
      return card;
    }
    if (
      !nameOnlyCandidate &&
      card.name === name &&
      card.outputText === undefined &&
      !fallbackMatchedCards.has(card)
    ) {
      nameOnlyCandidate = card;
    }
  }
  return nameOnlyCandidate;
}

export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const cards: ToolCard[] = [];
  const fallbackMatchedCards = new WeakSet<ToolCard>();
  const transcriptMessageId = resolveTranscriptMessageId(m);

  for (let index = 0; index < content.length; index++) {
    const item = content[index] ?? {};
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" &&
        (item.arguments != null || item.args != null || item.input != null));
    if (isToolCall) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        name: typeof item.name === "string" ? item.name : "tool",
        args,
        inputText: serializeToolInput(args),
        messageId: transcriptMessageId,
      });
      continue;
    }

    if (kind === "toolresult" || kind === "tool_result") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const cardId = resolveToolCardId(item, m, index, prefix);
      const existing = findFirstUnmatchedCard(cards, cardId, name, fallbackMatchedCards);
      const text = extractToolText(item);
      const preview = extractToolPreview(text, name);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      if (existing) {
        fallbackMatchedCards.add(existing);
        existing.outputText = text;
        existing.preview = preview;
        if (isError !== undefined) {
          existing.isError = isError;
        }
        continue;
      }
      cards.push({
        id: cardId,
        name,
        outputText: text,
        messageId: transcriptMessageId,
        ...(isError !== undefined ? { isError } : {}),
        preview,
      });
    }
  }

  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const isStandaloneToolMessage =
    isToolResultMessage(message) ||
    role === "tool" ||
    role === "function" ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";

  if (isStandaloneToolMessage && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      name,
      outputText: text,
      messageId: transcriptMessageId,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
      preview: extractToolPreview(text, name),
    });
  }

  return cards;
}

const toolCardsByMessage = new WeakMap<object, Map<string, ToolCard[]>>();

export function extractToolCardsCached(message: unknown, prefix = "tool"): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCards(message, prefix);
  }
  let byPrefix = toolCardsByMessage.get(message);
  if (!byPrefix) {
    byPrefix = new Map();
    toolCardsByMessage.set(message, byPrefix);
  }
  const cached = byPrefix.get(prefix);
  if (cached) {
    return cached;
  }
  const cards = extractToolCards(message, prefix);
  byPrefix.set(prefix, cards);
  return cards;
}

export function resolveToolCardPresentation(card: ToolCard): ToolCardPresentation {
  const argsRecord = isRecord(card.args) ? card.args : parseJsonRecord(card.inputText);
  const outputRecord = parseJsonRecord(card.outputText);
  const command =
    firstStringFromRecord(argsRecord, ["cmd", "command", "script", "shell"]) ??
    firstStringFromRecord(outputRecord, ["cmd", "command", "script", "shell"]);
  const kind = inferToolCardKind({
    argsRecord,
    command,
    name: card.name,
    outputRecord,
  });
  const facts: ToolCardFact[] = [];
  const status = kind === "tool" ? undefined : (statusFromEvidence(outputRecord) ?? "unknown");
  if (kind === "tool") {
    return {
      kind,
      eyebrow: "Tool",
      outputLabel: "Tool output",
      facts,
    };
  }

  if (status) {
    pushFact(facts, "Status", statusLabel(status));
  }
  pushFact(facts, "Command", command);
  pushFact(facts, "Exit", firstNumberFromRecord(outputRecord, ["exitCode", "exit_code", "code"]));
  pushFact(
    facts,
    "Duration",
    formatDuration(
      firstNumberFromRecord(outputRecord, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]),
    ),
  );
  pushFact(facts, "CWD", firstStringFromRecord(argsRecord, ["cwd", "path", "dir", "directory"]));
  pushFact(
    facts,
    "Run",
    firstStringFromRecord(outputRecord, ["runId", "run_id", "databaseId", "database_id"]),
  );
  pushFact(facts, "SHA", firstStringFromRecord(outputRecord, ["headSha", "head_sha", "sha"]));
  pushFact(facts, "URL", firstStringFromRecord(outputRecord, ["runUrl", "run_url", "url"]));
  pushFact(
    facts,
    "Artifact",
    firstStringFromRecord(outputRecord, [
      "artifactId",
      "artifact_id",
      "artifactPath",
      "artifact_path",
      "filePath",
      "file_path",
      "screenshotPath",
      "screenshot_path",
      "reportPath",
      "report_path",
      "path",
    ]),
  );

  if (kind === "command") {
    return {
      kind,
      eyebrow: "Command",
      outputLabel: "Command output",
      status,
      titleOverride: "Command",
      detail: command,
      facts,
      previewText: outputPreviewFromRecord(outputRecord),
    };
  }
  if (kind === "proof") {
    return {
      kind,
      eyebrow: "Proof",
      outputLabel: "Proof evidence",
      status,
      titleOverride: "Proof result",
      detail:
        firstStringFromRecord(outputRecord, [
          "workflow",
          "workflowName",
          "workflow_name",
          "proofKind",
          "proof_kind",
        ]) ?? command,
      facts,
      previewText: outputPreviewFromRecord(outputRecord),
    };
  }
  return {
    kind,
    eyebrow: "Artifact",
    outputLabel: "Artifact details",
    status,
    titleOverride: firstStringFromRecord(outputRecord, ["title", "name", "label"]) ?? "Artifact",
    detail: firstStringFromRecord(outputRecord, ["kind", "type", "mimeType", "mime_type"]),
    facts,
    previewText: outputPreviewFromRecord(outputRecord),
  };
}

export function buildToolCardSidebarContent(card: ToolCard): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const presentation = resolveToolCardPresentation(card);
  const detail = formatToolDetail(display);
  const isError = isToolCardError(card);
  const sections = [
    `## ${presentation.titleOverride ?? display.label}`,
    `**Tool:** \`${display.name}\``,
  ];

  if (presentation.kind !== "tool") {
    sections.push(`**Kind:** ${presentation.eyebrow}`);
  }

  if (presentation.status) {
    sections.push(`**Status:** ${statusLabel(presentation.status)}`);
  }

  if (presentation.facts.length > 0) {
    sections.push(
      `### Evidence\n${presentation.facts
        .map((fact) => `- **${fact.label}:** ${fact.value}`)
        .join("\n")}`,
    );
  }

  if (detail) {
    sections.push(`**Summary:** ${detail}`);
  }

  if (card.inputText?.trim()) {
    const inputIsJson = typeof card.args === "object" && card.args !== null;
    sections.push(
      `### Tool input\n${formatPayloadForSidebar(card.inputText, inputIsJson ? "json" : "text")}`,
    );
  }

  if (card.outputText?.trim()) {
    sections.push(
      `### ${isError ? "Tool error" : "Tool output"}\n${formatToolOutputForSidebar(card.outputText)}`,
    );
  } else {
    sections.push(
      isError
        ? "### Tool error\n*No output — tool failed.*"
        : "### Tool output\n*No output — tool completed successfully.*",
    );
  }

  return sections.join("\n\n");
}

function handleRawDetailsToggle(event: Event) {
  const button = event.currentTarget as HTMLButtonElement | null;
  const root = button?.closest(".chat-tool-card__raw");
  const body = root?.querySelector<HTMLElement>(".chat-tool-card__raw-body");
  if (!button || !body) {
    return;
  }
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  body.hidden = expanded;
}

function renderPreviewFrame(params: {
  title: string;
  src?: string;
  height?: number;
  sandbox?: string;
}) {
  const sandbox = params.sandbox ?? "";
  const src = params.src ?? "";
  return keyed(
    `${sandbox}\u0000${src}\u0000${params.height ?? ""}`,
    html`
      <iframe
        class="chat-tool-card__preview-frame"
        title=${params.title}
        sandbox=${sandbox}
        src=${src || nothing}
        style=${params.height ? `height:${params.height}px` : ""}
      ></iframe>
    `,
  );
}

export function renderToolPreview(
  preview: ToolPreview | undefined,
  surface: "chat_tool" | "chat_message" | "sidebar",
  options?: {
    onOpenSidebar?: (content: SidebarContent) => void;
    rawText?: string | null;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  if (!preview) {
    return nothing;
  }
  if (preview.kind !== "canvas" || surface === "chat_tool") {
    return nothing;
  }
  if (preview.surface !== "assistant_message") {
    return nothing;
  }
  return html`
    <div class="chat-tool-card__preview" data-kind="canvas" data-surface=${surface}>
      <div class="chat-tool-card__preview-header">
        <span class="chat-tool-card__preview-label">${preview.title?.trim() || "Canvas"}</span>
      </div>
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        ${renderPreviewFrame({
          title: preview.title?.trim() || "Canvas",
          src: resolveCanvasIframeUrl(
            preview.url,
            options?.canvasPluginSurfaceUrl,
            options?.allowExternalEmbedUrls ?? false,
          ),
          height: preview.preferredHeight,
          sandbox:
            preview.kind === "canvas"
              ? resolveEmbedSandbox(options?.embedSandboxMode ?? "scripts")
              : resolveCanvasPreviewSandbox(preview),
        })}
      </div>
    </div>
  `;
}

export function buildSidebarContent(
  value: string,
  options?: {
    rawText?: string | null;
    fullMessageRequest?: FullMessageRequest;
  },
): SidebarContent {
  return {
    kind: "markdown",
    content: value,
    ...(options?.rawText ? { rawText: options.rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

export function buildPreviewSidebarContent(
  preview: ToolPreview,
  rawText?: string | null,
  options?: { fullMessageRequest?: FullMessageRequest },
): SidebarContent | null {
  if (preview.kind !== "canvas" || preview.render !== "url" || !preview.viewId || !preview.url) {
    return null;
  }
  return {
    kind: "canvas",
    docId: preview.viewId,
    entryUrl: preview.url,
    ...(preview.title ? { title: preview.title } : {}),
    ...(preview.preferredHeight ? { preferredHeight: preview.preferredHeight } : {}),
    ...(rawText ? { rawText } : {}),
    ...(options?.fullMessageRequest ? { fullMessageRequest: options.fullMessageRequest } : {}),
  };
}

function buildToolSidebarFullMessageRequest(
  card: ToolCard,
  sessionKey: string | undefined,
): FullMessageRequest | undefined {
  if (!sessionKey || !card.messageId) {
    return undefined;
  }
  // A transcript entry can contain multiple tool blocks. Until the request can
  // identify a specific block, upgrading by message id can show the wrong tool.
  return undefined;
}

export function renderRawOutputToggle(text: string) {
  return html`
    <div class="chat-tool-card__raw">
      <button
        class="chat-tool-card__raw-toggle"
        type="button"
        aria-expanded="false"
        @click=${handleRawDetailsToggle}
      >
        <span>Raw details</span>
        <span class="chat-tool-card__raw-toggle-icon">${icons.chevronDown}</span>
      </button>
      <div class="chat-tool-card__raw-body" hidden>
        ${renderToolDataBlock({
          label: "Tool output",
          text,
          expanded: true,
        })}
      </div>
    </div>
  `;
}

function renderToolDataBlock(params: {
  label: string;
  text: string;
  expanded: boolean;
  empty?: boolean;
}) {
  const { label, text, expanded, empty } = params;
  return html`
    <div class="chat-tool-card__block ${expanded ? "chat-tool-card__block--expanded" : ""}">
      <div class="chat-tool-card__block-header">
        <span class="chat-tool-card__block-icon">${icons.zap}</span>
        <span class="chat-tool-card__block-label">${label}</span>
      </div>
      ${empty
        ? html`<div class="chat-tool-card__block-empty muted">${text}</div>`
        : expanded
          ? html`<pre class="chat-tool-card__block-content"><code>${text}</code></pre>`
          : html`<div class="chat-tool-card__block-preview mono">
              ${getTruncatedPreview(text)}
            </div>`}
    </div>
  `;
}

function renderToolCardEvidence(presentation: ToolCardPresentation) {
  if (presentation.kind === "tool") {
    return nothing;
  }
  return html`
    <div class="chat-tool-card__evidence" data-tool-card-kind=${presentation.kind}>
      <div class="chat-tool-card__evidence-header">
        <span class="chat-tool-card__eyebrow">${presentation.eyebrow}</span>
        ${presentation.status
          ? html`<span
              class="chat-tool-card__status-pill chat-tool-card__status-pill--${presentation.status}"
              >${statusLabel(presentation.status)}</span
            >`
          : nothing}
      </div>
      ${presentation.facts.length > 0
        ? html`<dl class="chat-tool-card__facts">
            ${presentation.facts.map(
              (fact) => html`
                <div class="chat-tool-card__fact">
                  <dt>${fact.label}</dt>
                  <dd>${fact.value}</dd>
                </div>
              `,
            )}
          </dl>`
        : html`<div class="chat-tool-card__status-text muted">Status unknown</div>`}
      ${presentation.previewText?.trim()
        ? renderToolDataBlock({
            label: "Evidence preview",
            text: presentation.previewText,
            expanded: false,
          })
        : nothing}
    </div>
  `;
}

function renderCollapsedToolSummary(params: {
  label: string;
  icon: ReturnType<typeof html> | undefined;
  name?: string;
  expanded: boolean;
  isError?: boolean;
  onToggleExpanded: () => void;
}) {
  const { label, icon, name, expanded, isError, onToggleExpanded } = params;
  const displayLabel = formatCollapsedToolSummaryText(label) ?? label;
  const displayName = formatCollapsedToolSummaryText(name);
  return html`
    <button
      class="chat-tool-msg-summary ${isError ? "chat-tool-msg-summary--error" : ""}"
      type="button"
      aria-expanded=${String(expanded)}
      @click=${() => onToggleExpanded()}
    >
      <span class="chat-tool-msg-summary__icon">${icon}</span>
      <span class="chat-tool-msg-summary__label">${displayLabel}</span>
      ${displayName
        ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>`
        : nothing}
      ${isError
        ? html`<span class="chat-tool-msg-summary__error-badge" aria-label="Tool returned an error"
            >${icons.x}<span>Error</span></span
          >`
        : nothing}
    </button>
  `;
}

export function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  const directDetail = displayDetail?.trim();
  if (directDetail) {
    return displayDetail;
  }
  if (typeof card.args !== "string") {
    return undefined;
  }
  const inputText = card.inputText?.trim() ? card.inputText : card.args;
  return formatCollapsedToolPreviewText(inputText);
}

export function resolveCollapsedToolSummaryParts(params: {
  card: ToolCard;
  displayLabel: string;
  displayDetail: string | undefined;
  isError: boolean;
}): { label: string; name?: string } {
  if (params.isError) {
    return { label: t("chat.toolCards.toolError"), name: params.displayLabel };
  }

  const displayDetail = params.displayDetail?.trim();
  if (displayDetail) {
    return { label: params.displayLabel, name: displayDetail };
  }

  return {
    label:
      typeof params.card.args === "string"
        ? (resolveCollapsedToolDetail(params.card, undefined) ?? params.displayLabel)
        : params.displayLabel,
  };
}

export function renderToolCard(
  card: ToolCard,
  opts: {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    sessionKey?: string;
    agentId?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    canvasPluginSurfaceUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const presentation = resolveToolCardPresentation(card);
  const isError = isToolCardError(card);
  const summary =
    presentation.kind !== "tool" && !isError
      ? {
          label: presentation.eyebrow,
          name: presentation.detail ?? presentation.titleOverride ?? display.label,
        }
      : resolveCollapsedToolSummaryParts({
          card,
          displayLabel: display.label,
          displayDetail: display.detail,
          isError,
        });

  return html`
    <div
      class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${opts.expanded
        ? "is-open"
        : ""}"
    >
      ${renderCollapsedToolSummary({
        label: summary.label,
        icon: icons[display.icon],
        name: summary.name,
        expanded: opts.expanded,
        isError,
        onToggleExpanded: () => opts.onToggleExpanded(card.id),
      })}
      ${opts.expanded
        ? html`
            <div class="chat-tool-msg-body">
              ${renderExpandedToolCardContent(
                card,
                opts.sessionKey,
                opts.onOpenSidebar,
                opts.canvasPluginSurfaceUrl,
                opts.embedSandboxMode ?? "scripts",
                opts.allowExternalEmbedUrls ?? false,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderExpandedToolCardContent(
  card: ToolCard,
  sessionKey?: string,
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasPluginSurfaceUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  allowExternalEmbedUrls = false,
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const presentation = resolveToolCardPresentation(card);
  const detail = formatToolDetail(display);
  const hasOutput = Boolean(card.outputText?.trim());
  const hasInput = Boolean(card.inputText?.trim());
  const isError = isToolCardError(card);
  const canOpenSidebar = Boolean(onOpenSidebar);
  const fullMessageRequest = buildToolSidebarFullMessageRequest(card, sessionKey);
  const previewSidebarContent =
    card.preview?.kind === "canvas"
      ? buildPreviewSidebarContent(card.preview, card.outputText, { fullMessageRequest })
      : null;
  const sidebarActionContent =
    previewSidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      fullMessageRequest,
      rawText: card.outputText ?? null,
    });
  const visiblePreview = card.preview
    ? renderToolPreview(card.preview, "chat_tool", {
        onOpenSidebar,
        rawText: card.outputText,
        canvasPluginSurfaceUrl,
        embedSandboxMode,
        allowExternalEmbedUrls,
      })
    : nothing;

  return html`
    <div class="chat-tool-card chat-tool-card--expanded ${isError ? "chat-tool-card--error" : ""}">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${presentation.titleOverride ?? display.label}</span>
          ${isError
            ? html`<span class="chat-tool-card__status-badge" role="status"
                >${icons.x}<span>Error</span></span
              >`
            : nothing}
        </div>
        ${canOpenSidebar
          ? html`
              <div class="chat-tool-card__actions">
                <button
                  class="chat-tool-card__action-btn"
                  type="button"
                  @click=${() => onOpenSidebar?.(sidebarActionContent)}
                  title="Open in the side panel"
                  aria-label="Open tool details in side panel"
                >
                  <span class="chat-tool-card__action-icon">${icons.panelRightOpen}</span>
                </button>
              </div>
            `
          : nothing}
      </div>
      ${presentation.detail || detail
        ? html`<div class="chat-tool-card__detail">${presentation.detail ?? detail}</div>`
        : nothing}
      ${renderToolCardEvidence(presentation)}
      ${hasInput
        ? renderToolDataBlock({
            label: "Tool input",
            text: card.inputText!,
            expanded: true,
          })
        : nothing}
      ${hasOutput
        ? card.preview
          ? html`${visiblePreview} ${renderRawOutputToggle(card.outputText!)}`
          : renderToolDataBlock({
              label: isError ? "Tool error" : presentation.outputLabel,
              text: card.outputText!,
              expanded: true,
            })
        : nothing}
    </div>
  `;
}

export function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: SidebarContent) => void,
  canvasPluginSurfaceUrl?: string | null,
  embedSandboxMode: EmbedSandboxMode = "scripts",
  options?: { sessionKey?: string; agentId?: string },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const preview = card.preview;
  const hasText = Boolean(card.outputText?.trim());
  const hasPreview = Boolean(preview);
  const isError = isToolCardError(card);
  const fullMessageRequest = buildToolSidebarFullMessageRequest(card, options?.sessionKey);
  const sidebarContent =
    preview?.kind === "canvas"
      ? buildPreviewSidebarContent(preview, card.outputText, { fullMessageRequest })
      : buildSidebarContent(buildToolCardSidebarContent(card), {
          fullMessageRequest,
          rawText: card.outputText ?? null,
        });
  const actionContent =
    sidebarContent ??
    buildSidebarContent(buildToolCardSidebarContent(card), {
      fullMessageRequest,
      rawText: card.outputText ?? null,
    });
  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick ? () => onOpenSidebar?.(actionContent) : undefined;
  const isShort = hasText && !hasPreview && (card.outputText?.length ?? 0) <= 240;
  const showCollapsed = hasText && !hasPreview && !isShort;
  const showInline = hasText && !hasPreview && isShort;
  const isEmpty = !hasText && !hasPreview;
  const statusIcon = isError ? icons.x : icons.check;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""} ${isError
        ? "chat-tool-card--error"
        : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick
        ? (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") {
              return;
            }
            e.preventDefault();
            handleClick?.();
          }
        : nothing}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span
              class="chat-tool-card__action ${isError ? "chat-tool-card__action--error" : ""}"
              >${isError ? "View error" : hasText || hasPreview ? "View" : ""} ${statusIcon}</span
            >`
          : nothing}
        ${isEmpty && !canClick
          ? html`<span
              class="chat-tool-card__status ${isError ? "chat-tool-card__status--error" : ""}"
              >${statusIcon}</span
            >`
          : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${isEmpty
        ? html`<div
            class="chat-tool-card__status-text ${isError
              ? "chat-tool-card__status-text--error"
              : "muted"}"
          >
            ${isError ? "Failed" : "Completed"}
          </div>`
        : nothing}
      ${preview
        ? html`${renderToolPreview(preview, "chat_tool", {
            onOpenSidebar,
            rawText: card.outputText,
            canvasPluginSurfaceUrl,
            embedSandboxMode,
          })}`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono">
            ${getTruncatedPreview(card.outputText!)}
          </div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono">${card.outputText}</div>`
        : nothing}
    </div>
  `;
}
