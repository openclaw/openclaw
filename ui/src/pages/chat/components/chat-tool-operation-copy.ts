import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  unwrapToolCallForDisplay,
  unwrapToolResultTextForDisplay,
} from "../../../../../src/agents/tool-display-call.js";
import { truncateUtf16WithEllipsis } from "../../../../../src/shared/text-truncate.js";
import type { IconName } from "../../../components/icon-data.ts";
import { registerChatToolOperationsEnglish } from "../../../i18n/locales/en-chat-tool-operations.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatToolOperationsEnglish);

const catalog: Readonly<Record<string, object>> =
  registerChatToolOperationsEnglish.catalog.chat.toolCards.operationLabels;

const operationIcons = new Map<string, IconName>([
  ["discussion", "messageSquare"],
  ["facetime_call", "audioLines"],
  ["feishu_app_scopes", "fileText"],
  ["feishu_bitable_create_app", "fileText"],
  ["feishu_bitable_create_field", "fileText"],
  ["feishu_bitable_create_record", "fileText"],
  ["feishu_bitable_get_meta", "fileText"],
  ["feishu_bitable_get_record", "fileText"],
  ["feishu_bitable_list_fields", "fileText"],
  ["feishu_bitable_list_records", "fileText"],
  ["feishu_bitable_update_record", "fileText"],
  ["feishu_chat", "fileText"],
  ["feishu_doc", "fileText"],
  ["feishu_drive", "fileText"],
  ["feishu_perm", "fileText"],
  ["feishu_wiki", "fileText"],
  ["google_meet", "users"],
  ["slack_huddles", "users"],
  ["talk_voice", "audioLines"],
  ["teams_meetings", "users"],
  ["voice_call", "audioLines"],
  ["whatsapp_call", "messageCircle"],
  ["whatsapp_login", "messageCircle"],
  ["zalouser", "messageCircle"],
  ["zoom_meetings", "users"],
  ["facetime_end_call", "audioLines"],
  ["openclaw_end_call", "audioLines"],
  ["x_search", "search"],
  ["theme", "pipette"],
  ["portal", "panelsTopLeft"],
  ["canvas", "panelsTopLeft"],
  ["show_widget", "layoutDashboard"],
  ["deep_research", "search"],
  ["firecrawl_search", "globe"],
  ["firecrawl_scrape", "globe"],
  ["tavily_search", "globe"],
  ["tavily_extract", "globe"],
  ["code_execution", "search"],
  ["crabbox", "box"],
  ["diffs", "fileDiff"],
  ["file_fetch", "file"],
  ["dir_list", "file"],
  ["dir_fetch", "file"],
  ["file_write", "file"],
  ["qa_restart_wait", "bug"],
  ["qa_restart_unsafe_probe", "bug"],
  ["decision_evaluate", "scale"],
  ["sessions_create", "messageSquarePlus"],
  ["sessions_history", "messageSquare"],
  ["conversations_turn", "messageSquare"],
  ["github_identity_status", "github"],
  ["session_project", "folder"],
  ["sessions_yield", "clock"],
  ["suggest_task", "listTodo"],
  ["dismiss_task", "listTodo"],
  ["agents_list", "bot"],
  ["skill_workshop", "book"],
  ["codex_threads", "squareTerminal"],
  ["codex_plugins", "squareTerminal"],
  ["codex_endpoint_probe", "squareTerminal"],
  ["codex_sessions_list", "squareTerminal"],
  ["codex_session_read", "squareTerminal"],
  ["codex_session_send", "squareTerminal"],
  ["codex_session_interrupt", "squareTerminal"],
]);

export function catalogToolIcon(name: string): IconName | undefined {
  return operationIcons.get(name.trim().toLowerCase());
}

function readMessageReceipt(card: ToolCard): Record<string, unknown> | undefined {
  const details = asNullableRecord(card.details);
  // History projects only a few fields from details; the channel receipt stays in the JSON output.
  const receipt = {
    ...safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? "")),
    ...(asNullableRecord(asNullableRecord(details?.result)?.details) ?? details),
  };
  // Telegram can echo the attempted change in a refusal. None of those fields confirms an effect.
  if (receipt.ok === false) {
    return { ok: false };
  }
  return receipt.ok === true ? receipt : undefined;
}

function browserOperation(args: Record<string, unknown> | null, labels: object): string {
  const kind = asNullableRecord(args?.request)?.kind ?? args?.kind;
  if (typeof kind !== "string") {
    return "act";
  }
  const key = `act_${kind}`;
  return Object.hasOwn(labels, key) ? key : "act";
}

function describedNodeName(selector: unknown, details: unknown): string | undefined {
  if (typeof selector !== "string") {
    return undefined;
  }
  const node = selector.trim();
  if (!/^\p{L}[\p{L}\p{M}\p{N} '’-]*$/u.test(node)) {
    return undefined;
  }
  // IDs, their prefixes and IPs cannot contain spaces. A single token needs a recorded name.
  if (node.includes(" ")) {
    return node;
  }
  const receipt = asNullableRecord(details);
  const described = asNullableRecord(asNullableRecord(receipt?.result)?.details) ?? receipt;
  return node === described?.displayName && node !== described.nodeId ? node : undefined;
}

export function catalogToolOperation(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string },
): { label: string; showOutcome?: true } | undefined {
  const call = unwrapToolCallForDisplay(card);
  const name = call.name.trim().toLowerCase();
  const args = asNullableRecord(call.args);
  if (name === "toolsearch" || name === "tool_search") {
    const selecting =
      name === "toolsearch" &&
      typeof args?.query === "string" &&
      args.query.trim().startsWith("select:");
    const action = selecting
      ? outcome === "running"
        ? "selectingTools"
        : outcome === "succeeded"
          ? "selectedTools"
          : "selectTools"
      : outcome === "running"
        ? "searchingTools"
        : outcome === "succeeded"
          ? "searchedTools"
          : "searchTools";
    return { label: t(`chat.toolCards.${action}`) };
  }
  if (name === "sessions_list") {
    return {
      label: t(
        `chat.toolCards.${outcome === "running" ? "listingChats" : outcome === "succeeded" ? "listedChats" : "listChats"}`,
      ),
    };
  }
  // A completed tool call is not a delivery receipt. A turn can also finish without a reply.
  if (outcome === "succeeded" && (name === "conversations_send" || name === "conversations_turn")) {
    const status =
      asNullableRecord(card.details)?.status ??
      safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? ""))?.status;
    const receipt =
      status === "sent" ||
      status === "queued" ||
      status === "suppressed" ||
      (name === "conversations_turn" && (status === "replied" || status === "timeout"))
        ? status
        : "unknown";
    return { label: t(`chat.toolCards.conversationDelivery.${receipt}`) };
  }
  const labels = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!labels) {
    return undefined;
  }
  let action = typeof args?.action === "string" ? args.action : undefined;
  if (name === "message" && action === "react") {
    const receipt =
      outcome === "succeeded" && args?.dryRun !== true ? readMessageReceipt(card) : undefined;
    const removed = receipt?.removed;
    const clearCount = Array.isArray(removed)
      ? removed.length
      : typeof removed === "number"
        ? removed
        : undefined;
    if (args?.remove === true || receipt?.remove === true || removed === null) {
      action = "remove_reaction";
    } else if (
      clearCount !== undefined ||
      (typeof args?.emoji === "string"
        ? !args.emoji.trim()
        : args?.channel === "feishu" && args.clearAll === true)
    ) {
      action = "clear_reactions";
    }
    if (receipt?.ok === false || receipt?.dryRun === true) {
      return t(`chat.toolCards.operationLabels.message.${action}.action`);
    }
    if (receipt?.changed === false || removed === null || clearCount === 0) {
      return t(`chat.toolCards.operationLabels.message.${action}.unchanged`);
    }
  }
  const key =
    name === "update_goal" && typeof args?.status === "string"
      ? `status_${args.status}`
      : name === "browser" && action === "act"
        ? browserOperation(args, labels)
        : action?.replaceAll(".", "_");
  const operation = key && Object.hasOwn(labels, key) ? key : "default";
  if (!Object.hasOwn(labels, operation)) {
    return undefined;
  }
  let phase =
    outcome === "running"
      ? "running"
      : outcome === "succeeded" && !(name === "message" && args?.dryRun === true)
        ? "done"
        : "action";
  if (name === "message" && operation === "reply" && phase === "done") {
    const receipt = readMessageReceipt(card);
    const messageId = normalizeOptionalString(receipt?.messageId);
    // repliedTo is the parent. The iMessage bridge can return "ok" or "unknown" without a new ID.
    if (
      !normalizeOptionalString(receipt?.repliedTo) ||
      !messageId ||
      ["ok", "unknown", "skipped", "suppressed"].includes(messageId) ||
      receipt?.dryRun === true ||
      receipt?.status === "suppressed"
    ) {
      phase = "action";
    }
  }
  const query =
    name === "web_search" && typeof args?.query === "string"
      ? truncateUtf16WithEllipsis(
          args.query.replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, " ").trim(),
          120,
        )
      : undefined;
  const label = t(
    `chat.toolCards.operationLabels.${name}.${operation}.${phase}${query ? "WithQuery" : ""}`,
    query ? { query } : undefined,
  );
  const target =
    name === "nodes" && operation === "describe"
      ? describedNodeName(args?.node, card.details)
      : addressed?.name;
  return {
    label: target ? t("chat.toolCards.namedOperation", { action: label, name: target }) : label,
    showOutcome: true,
  };
}
