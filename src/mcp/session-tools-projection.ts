import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import {
  type AgentSummary,
  MAX_AGENT_EMOJI_CHARS,
  MAX_DATA_ICON_CHARS,
  MAX_DATE_MS,
  MAX_HISTORY_CHARS,
  MAX_LIST_ICON_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_PREVIEW_CHARS,
  MAX_TITLE_CHARS,
  SAFE_RASTER_DATA_ICON_PATTERN,
  type SessionAgent,
  type SessionItem,
  type SessionRow,
  type SessionStatus,
} from "./session-tools-contract.js";

export function defaultCollectionRows(
  activeRows: SessionRow[],
  archivedRows: SessionRow[],
  limit: number,
) {
  const active = [...new Map(activeRows.map((row) => [row.key, row])).values()];
  const activeKeys = new Set(active.map((row) => row.key));
  const archived = [...new Map(archivedRows.map((row) => [row.key, row])).values()].filter(
    (row) => !activeKeys.has(row.key),
  );
  const archivedReserve = limit >= 5 ? Math.min(archived.length, Math.ceil(limit / 5)) : 0;
  const selectedActive = active.slice(0, limit - archivedReserve);
  return [...selectedActive, ...archived.slice(0, limit - selectedActive.length)];
}

export function sessionItem(
  row: SessionRow,
  agentId: string,
  id: string,
  agent?: AgentSummary,
): SessionItem {
  const title =
    boundedText(row.label, MAX_TITLE_CHARS) ??
    boundedText(row.derivedTitle, MAX_TITLE_CHARS) ??
    boundedText(row.displayName, MAX_TITLE_CHARS) ??
    "New session";
  const icon = agentIcon(agent);
  const preview = boundedText(row.lastMessagePreview, MAX_PREVIEW_CHARS);
  const updatedAt = isoTimestamp(row.updatedAt);
  return {
    id,
    agentId,
    title,
    ...(preview ? { preview } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    status: sessionStatus(row),
    unread: row.unread === true,
    pinned: row.pinned === true,
    archived: row.archived === true,
    ...(icon ? { icons: [{ src: icon }] } : {}),
    toolArguments: { session_id: id, chrome: "detail" },
  };
}

export function boundedSessionListIcons(
  items: SessionItem[],
  agents: SessionAgent[],
): { items: SessionItem[]; agents: SessionAgent[] } {
  let remaining = MAX_LIST_ICON_CHARS;
  const boundedAgents = agents.map((agent) => {
    const src = agent.icon?.src;
    if (!src || src.length > remaining) {
      const { icon: _icon, ...withoutIcon } = agent;
      return withoutIcon;
    }
    remaining -= src.length;
    return agent;
  });
  const boundedItems = items.map((item) => {
    const src = item.icons?.[0]?.src;
    if (!src || src.length > remaining) {
      const { icons: _icons, ...withoutIcons } = item;
      return withoutIcons;
    }
    remaining -= src.length;
    return item;
  });
  return { items: boundedItems, agents: boundedAgents };
}

export function sessionAgent(agent: AgentSummary): SessionAgent {
  const icon = agentIcon(agent);
  return {
    id: agent.id,
    title:
      boundedText(agent.identity?.name, MAX_TITLE_CHARS) ??
      boundedText(agent.name, MAX_TITLE_CHARS) ??
      agent.id,
    ...(icon ? { icon: { src: icon, fallback: agentFallback(agent, agent.id) } } : {}),
  };
}

function agentFallback(agent: AgentSummary | undefined, agentId: string): string {
  return (
    boundedText(agent?.identity?.emoji, MAX_AGENT_EMOJI_CHARS) ??
    boundedText(agent?.identity?.name, 1)?.toUpperCase() ??
    boundedText(agent?.name, 1)?.toUpperCase() ??
    agentId.slice(0, 1).toUpperCase()
  );
}

function sessionStatus(row: SessionRow): SessionStatus {
  if (row.hasActiveRun === true || row.status === "running") {
    return "working";
  }
  if (row.status === "failed" || row.status === "timeout") {
    return "error";
  }
  return "idle";
}

function agentIcon(agent: AgentSummary | undefined): string | undefined {
  const avatarUrl = agent?.identity?.avatarUrl?.trim();
  if (
    avatarUrl &&
    avatarUrl.length <= MAX_DATA_ICON_CHARS &&
    SAFE_RASTER_DATA_ICON_PATTERN.test(avatarUrl)
  ) {
    return avatarUrl;
  }
  const emoji = boundedText(agent?.identity?.emoji, MAX_AGENT_EMOJI_CHARS);
  if (!emoji) {
    return undefined;
  }
  const safeEmoji = emoji
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="23" text-anchor="middle" font-size="23">${safeEmoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function visibleMessages(
  messages: unknown[],
): Array<{ role: "user" | "assistant"; text: string }> {
  const visible: Array<{ role: "user" | "assistant"; text: string }> = [];
  let remaining = MAX_HISTORY_CHARS;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (remaining <= 0 || !message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text =
      role === "assistant" ? extractAssistantVisibleText(message) : extractUserText(message);
    if (!text) {
      continue;
    }
    const bounded = truncateUtf16Safe(text.trim(), Math.min(MAX_MESSAGE_CHARS, remaining));
    if (!bounded) {
      continue;
    }
    visible.push({ role, text: bounded });
    remaining -= bounded.length;
  }
  return visible.toReversed();
}

function extractUserText(message: object): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    return (type === "text" || type === "input_text") && typeof text === "string" ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function boundedText(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxChars) : undefined;
}

export function isoTimestamp(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DATE_MS) {
    return undefined;
  }
  return new Date(value).toISOString();
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
