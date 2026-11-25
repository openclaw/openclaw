import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  unwrapToolCallForDisplay,
  unwrapToolResultTextForDisplay,
} from "../../../../../src/agents/tool-display-call.js";
import type { IconName } from "../../../components/icon-data.ts";
import { registerChatToolOperationsEnglish } from "../../../i18n/locales/en-chat-tool-operations.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatToolOperationsEnglish);

const catalog: Readonly<Record<string, object>> =
  registerChatToolOperationsEnglish.catalog.chat.toolCards.operationLabels;

const operationIcons = new Map<string, IconName>([
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

export function catalogToolLabel(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string },
): string | undefined {
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
    return t(`chat.toolCards.${action}`);
  }
  if (name === "sessions_list") {
    return t(
      `chat.toolCards.${outcome === "running" ? "listingChats" : outcome === "succeeded" ? "listedChats" : "listChats"}`,
    );
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
    return t(`chat.toolCards.conversationDelivery.${receipt}`);
  }
  const labels = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!labels) {
    return undefined;
  }
  const action = typeof args?.action === "string" ? args.action : undefined;
  const key =
    name === "update_goal" && typeof args?.status === "string"
      ? `status_${args.status}`
      : action?.replaceAll(".", "_");
  const operation = key && Object.hasOwn(labels, key) ? key : "default";
  if (!Object.hasOwn(labels, operation)) {
    return undefined;
  }
  const phase = outcome === "running" ? "running" : outcome === "succeeded" ? "done" : "action";
  const label = t(`chat.toolCards.operationLabels.${name}.${operation}.${phase}`);
  const actionLabel = addressed?.name
    ? t("chat.toolCards.namedOperation", { action: label, name: addressed.name })
    : label;
  switch (outcome) {
    case "unknown":
      return t("chat.toolCards.operationUnknown", { action: actionLabel });
    case "unrecorded":
      return t("chat.toolCards.operationNoResult", { action: actionLabel });
    case "blocked":
      return t("chat.toolCards.operationBlocked", { action: actionLabel });
    default:
      return actionLabel;
  }
}
