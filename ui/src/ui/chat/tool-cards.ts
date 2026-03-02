import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

type ToolSidebarContentInput = {
  displayLabel: string;
  detail?: string;
  hasSidebarOutput: boolean;
  formattedOutput: string;
  rawOutput?: string;
};

export type ToolCardOutputLookup = {
  byToolCallId: Map<string, string>;
  bySignature: Map<string, string>;
  byResourceHint: Map<string, string>;
};

type ToolLookupSource = "toolCallId" | "signature" | "resourceHint";

type ToolLookupMatch = {
  source: ToolLookupSource;
  text: string;
};

type ExtractToolCardsOptions = {
  readFallbackText?: string;
};

export function extractToolCards(
  message: unknown,
  options: ExtractToolCardsOptions = {},
): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const fallbackToolCallId = resolveToolCallId(m);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
        toolCallId: resolveToolCallId(item, fallbackToolCallId),
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({
      kind: "result",
      name,
      text,
      toolCallId: resolveToolCallId(item, fallbackToolCallId),
    });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text, toolCallId: fallbackToolCallId });
  }

  const merged = mergeToolCards(cards);
  applyReadFallbackText(merged, options.readFallbackText);
  return merged;
}

export function buildToolCardOutputLookup(messages: unknown[]): ToolCardOutputLookup {
  const lookup: ToolCardOutputLookup = {
    byToolCallId: new Map<string, string>(),
    bySignature: new Map<string, string>(),
    byResourceHint: new Map<string, string>(),
  };
  for (const message of messages) {
    const cards = extractToolCards(message);
    for (const card of cards) {
      const text = normalizeToolText(card.text);
      if (!text) {
        continue;
      }
      const toolCallId = normalizeToolCallId(card.toolCallId);
      if (toolCallId) {
        lookup.byToolCallId.set(toolCallId, text);
      }
      const signature = buildToolSignature(card.name, card.args);
      if (signature) {
        lookup.bySignature.set(signature, text);
      }
      const resourceHint = buildResourceHint(card);
      if (resourceHint) {
        lookup.byResourceHint.set(resourceHint, text);
      }
    }
  }
  return lookup;
}

export function enrichToolCardsWithLookup(
  cards: ToolCard[],
  lookup: ToolCardOutputLookup | undefined,
): ToolCard[] {
  if (!lookup) {
    return cards;
  }
  return cards.map((card) => {
    const candidate = resolveLookupText(card, lookup);
    if (!candidate || !shouldApplyLookupText(card, candidate)) {
      return card;
    }
    return { ...card, text: candidate.text };
  });
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const formattedOutput = formatToolOutputForSidebar(card.text ?? "", {
    toolName: card.name,
    args: card.args,
  });
  const hasSidebarOutput = formattedOutput.trim().length > 0;
  const sidebarContent = buildToolSidebarContent({
    displayLabel: display.label,
    detail,
    hasSidebarOutput,
    formattedOutput,
    rawOutput: card.text ?? "",
  });

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        onOpenSidebar!(sidebarContent);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText && !hasSidebarOutput;
  const canView = hasText || hasSidebarOutput;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${
          canClick
            ? html`<span class="chat-tool-card__action">${canView ? "View " : ""}${icons.check}</span>`
            : nothing
        }
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isEmpty
          ? html`
              <div class="chat-tool-card__status-text muted">Completed</div>
            `
          : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

export function buildToolSidebarContent(input: ToolSidebarContentInput): string {
  const official = buildOfficialToolInfo({
    displayLabel: input.displayLabel,
    detail: input.detail,
    includeNoOutput: !input.hasSidebarOutput,
  });
  if (!input.hasSidebarOutput) {
    return official;
  }
  const sections = [official, input.formattedOutput];
  const rawSection = buildRawOutputSection(input.rawOutput, input.formattedOutput);
  if (rawSection) {
    sections.push(rawSection);
  }
  return sections.join("\n\n---\n\n");
}

function buildOfficialToolInfo(params: {
  displayLabel: string;
  detail?: string;
  includeNoOutput: boolean;
}): string {
  const lines = [`## ${params.displayLabel}`, ""];
  if (params.detail) {
    lines.push(`**Command:** \`${escapeInlineCode(params.detail)}\``);
  }
  if (params.includeNoOutput) {
    if (params.detail) {
      lines.push("");
    }
    lines.push("*No output - tool completed successfully.*");
  }
  return lines.join("\n");
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function buildRawOutputSection(
  rawOutput: string | undefined,
  formattedOutput: string,
): string | null {
  const raw = typeof rawOutput === "string" ? rawOutput.trim() : "";
  if (!raw) {
    return null;
  }
  if (isRawAlreadyVisible(raw, formattedOutput)) {
    return null;
  }
  return `### Raw Output\n\n${createCodeFence(raw, "text")}`;
}

function isReadToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "read" || /(^|[.:/_-])read$/.test(normalized);
}

function isRawAlreadyVisible(raw: string, formattedOutput: string): boolean {
  const formatted = formattedOutput.trim();
  if (!formatted) {
    return false;
  }
  if (formatted === raw) {
    return true;
  }
  const unwrapped = unwrapSingleCodeFence(formatted);
  if (unwrapped && unwrapped.trim() === raw) {
    return true;
  }
  const fencedBodies = extractCodeFenceBodies(formatted);
  if (fencedBodies.some((body) => body.trim() === raw)) {
    return true;
  }
  if (formatted.includes(raw)) {
    return true;
  }
  return false;
}

function unwrapSingleCodeFence(markdown: string): string | null {
  const match = markdown.trim().match(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1$/);
  if (!match) {
    return null;
  }
  return match[2];
}

function createCodeFence(content: string, language = ""): string {
  const runs = content.match(/`+/g) ?? [];
  const requiredLength = runs.reduce((max, run) => Math.max(max, run.length + 1), 3);
  const fence = "`".repeat(requiredLength);
  const lang = language.trim();
  return `${fence}${lang}\n${content}\n${fence}`;
}

function extractCodeFenceBodies(markdown: string): string[] {
  const blocks: string[] = [];
  const matches = markdown.matchAll(/(`{3,})[^\n]*\n([\s\S]*?)\n\1/g);
  for (const match of matches) {
    const body = match[2];
    if (typeof body === "string") {
      blocks.push(body);
    }
  }
  return blocks;
}

function applyReadFallbackText(cards: ToolCard[], fallbackText: string | undefined) {
  const normalizedFallback = typeof fallbackText === "string" ? fallbackText.trim() : "";
  if (!normalizedFallback) {
    return;
  }
  for (const card of cards) {
    if (!isReadToolName(card.name)) {
      continue;
    }
    if (typeof card.text === "string" && card.text.trim()) {
      continue;
    }
    card.text = normalizedFallback;
  }
}

function mergeToolCards(cards: ToolCard[]): ToolCard[] {
  for (let i = 0; i < cards.length; i += 1) {
    const resultCard = cards[i];
    if (resultCard.kind !== "result") {
      continue;
    }
    for (let j = i - 1; j >= 0; j -= 1) {
      const callCard = cards[j];
      if (callCard.kind !== "call" || callCard.name !== resultCard.name) {
        continue;
      }
      if (
        callCard.toolCallId &&
        resultCard.toolCallId &&
        normalizeToolCallId(callCard.toolCallId) !== normalizeToolCallId(resultCard.toolCallId)
      ) {
        continue;
      }
      if (!callCard.text && resultCard.text) {
        callCard.text = resultCard.text;
      }
      if (resultCard.args === undefined && callCard.args !== undefined) {
        resultCard.args = callCard.args;
      }
      if (!callCard.toolCallId && resultCard.toolCallId) {
        callCard.toolCallId = resultCard.toolCallId;
      }
      if (!resultCard.toolCallId && callCard.toolCallId) {
        resultCard.toolCallId = callCard.toolCallId;
      }
      break;
    }
  }
  return cards;
}

function resolveToolCallId(
  value: Record<string, unknown>,
  fallback?: string | undefined,
): string | undefined {
  const direct =
    (typeof value.toolCallId === "string" && value.toolCallId) ||
    (typeof value.tool_call_id === "string" && value.tool_call_id) ||
    fallback;
  const normalized = normalizeToolCallId(direct);
  return normalized || undefined;
}

function normalizeToolCallId(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeToolText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldApplyLookupText(card: ToolCard, candidate: ToolLookupMatch): boolean {
  const normalizedCurrent = normalizeToolText(card.text);
  if (!normalizedCurrent) {
    return true;
  }
  return candidate.source === "toolCallId" && normalizedCurrent !== candidate.text;
}

function resolveLookupText(
  card: ToolCard,
  lookup: ToolCardOutputLookup,
): ToolLookupMatch | undefined {
  const toolCallId = normalizeToolCallId(card.toolCallId);
  if (toolCallId) {
    const byId = lookup.byToolCallId.get(toolCallId);
    if (byId) {
      return { source: "toolCallId", text: byId };
    }
  }
  const signature = buildToolSignature(card.name, card.args);
  if (!signature) {
    const resourceHint = buildResourceHint(card);
    if (!resourceHint) {
      return undefined;
    }
    const byResourceHint = lookup.byResourceHint.get(resourceHint);
    return byResourceHint ? { source: "resourceHint", text: byResourceHint } : undefined;
  }
  const bySignature = lookup.bySignature.get(signature);
  if (bySignature) {
    return { source: "signature", text: bySignature };
  }
  const resourceHint = buildResourceHint(card);
  if (!resourceHint) {
    return undefined;
  }
  const byResourceHint = lookup.byResourceHint.get(resourceHint);
  return byResourceHint ? { source: "resourceHint", text: byResourceHint } : undefined;
}

function buildToolSignature(name: string, args: unknown): string {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) {
    return "";
  }
  const argsKey = stableSerialize(args);
  return `${normalizedName}::${argsKey}`;
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(stableNormalize(value));
  } catch {
    return String(value ?? "");
  }
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    normalized[key] = stableNormalize(record[key]);
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function buildResourceHint(card: ToolCard): string {
  const normalizedName = card.name.trim().toLowerCase();
  if (!normalizedName) {
    return "";
  }
  const resource = resolveResourceHint(card);
  if (!resource) {
    return "";
  }
  return `${normalizedName}::${resource}`;
}

function resolveResourceHint(card: ToolCard): string | null {
  const argsRecord = asRecord(card.args);
  const fromArgs =
    pickString(argsRecord, [
      "url",
      "uri",
      "path",
      "file",
      "filePath",
      "file_path",
      "cmd",
      "command",
      "query",
    ]) ?? null;
  if (fromArgs) {
    return normalizeResourceHintValue(fromArgs);
  }
  const fromText = extractFirstUrl(card.text) ?? extractFirstPathLikeToken(card.text);
  if (!fromText) {
    return null;
  }
  return normalizeResourceHintValue(fromText);
}

function normalizeResourceHintValue(value: string): string {
  return value.trim().toLowerCase();
}

function extractFirstUrl(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/https?:\/\/[^\s"')\]}]+/i);
  if (!match) {
    return null;
  }
  return match[0];
}

function extractFirstPathLikeToken(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/);
  if (!match) {
    return null;
  }
  return match[0];
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
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
    const parts = item.content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          return record.text;
        }
        if (typeof record.text === "string") {
          return record.text;
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (item.content && typeof item.content === "object") {
    const record = item.content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }
  if (item.result && typeof item.result === "object") {
    const record = item.result as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }
  return undefined;
}
