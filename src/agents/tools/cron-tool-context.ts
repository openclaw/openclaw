import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isCronModelManagementAllowed } from "../../gateway/cron-creator-authority-grant.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { REMINDER_CONTEXT_MESSAGES_MAX } from "./cron-tool-schema.js";
import type { ChatMessage, CronToolOptions, GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export function resolveCronToolCatalogShape(params: {
  opts?: CronToolOptions;
  config?: OpenClawConfig;
  managementAuthority?: { managementOnly: boolean };
  activeRun: boolean;
  nextCheckEnabled: boolean;
}): {
  selfRemoveOnly: boolean;
  management: "only" | "also" | undefined;
  managementOnly: boolean | undefined;
  activeRun: boolean;
  nextCheckEnabled: boolean;
} {
  const selfRemoveOnly =
    Boolean(params.opts?.selfRemoveOnlyJobId?.trim()) &&
    (!params.opts?.agentSessionKey?.trim() || isCronSessionKey(params.opts.agentSessionKey));
  if (params.opts?.stableCatalog === true && !selfRemoveOnly) {
    return {
      selfRemoveOnly,
      management: isCronModelManagementAllowed(params.config) ? "also" : undefined,
      managementOnly: false,
      activeRun: false,
      nextCheckEnabled: false,
    };
  }
  return {
    selfRemoveOnly,
    management:
      params.managementAuthority && (params.managementAuthority.managementOnly ? "only" : "also"),
    managementOnly: params.managementAuthority?.managementOnly,
    activeRun: params.activeRun,
    nextCheckEnabled: params.nextCheckEnabled,
  };
}

const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
export const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

export function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function truncateText(input: string, maxLen: number) {
  return truncateWithMarker(input, maxLen, { marker: "...", reserve: 3, trimEnd: true });
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractTextFromChatContent(message.content);
  return text ? { role, text } : null;
}

export async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  agentId?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
  callGatewayTool: GatewayToolCaller;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = getRuntimeConfig();
  const { alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ key: sessionKey, alias });
  try {
    const res = await params.callGatewayTool<{ messages: Array<unknown> }>(
      "chat.history",
      params.gatewayOpts,
      {
        sessionKey: resolvedKey,
        agentId: params.agentId,
        limit: maxMessages,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}
