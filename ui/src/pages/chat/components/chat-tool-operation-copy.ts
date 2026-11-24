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
  ["local_image", "image"],
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

function browserOperation(args: Record<string, unknown> | null, labels: object): string {
  const kind = asNullableRecord(args?.request)?.kind ?? args?.kind;
  if (typeof kind !== "string") {
    return "act";
  }
  const key = `act_${kind}`;
  return Object.hasOwn(labels, key) ? key : "act";
}

function completedMediaGenerationPhase(card: ToolCard, kind: string) {
  const details = asNullableRecord(card.details);
  const receipt = asNullableRecord(asNullableRecord(details?.result)?.details) ?? details;
  if (receipt?.action === "status" || receipt?.duplicateGuard === true) {
    return "action";
  }
  if (receipt?.async === true && typeof receipt.status === "string") {
    return receipt.status === "started" ? "requested" : "action";
  }
  if (Array.isArray(receipt?.attachments)) {
    return receipt.async !== true && receipt.attachments.length > 0 ? "done" : "action";
  }
  // History may keep only the producer's opening sentence (after an optional review notice).
  const output = unwrapToolResultTextForDisplay(card.outputText ?? "");
  const startedKind =
    /^(?:Review-before-delivery is enabled\.[^\n]*\n)?Background task started for (image|music|video) generation \([^\s()]+\)\./u.exec(
      output,
    )?.[1];
  if (startedKind === kind) {
    return "requested";
  }
  const generatedUnit =
    /^Generated [1-9]\d* (image|track|video)s? with [^/\n]+\/[^\n]+\.(?:\r?\n|$)/u.exec(
      output,
    )?.[1];
  return receipt?.async !== true && generatedUnit === (kind === "music" ? "track" : kind)
    ? "done"
    : "action";
}

export function catalogToolLabel(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string },
): string | undefined {
  const call = unwrapToolCallForDisplay(card);
  const name = call.name.trim().toLowerCase();
  const args = asNullableRecord(call.args);
  const mediaGenerator =
    name === "image_generate" || name === "music_generate" || name === "video_generate";
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
  const labels = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!labels) {
    return undefined;
  }
  const action = typeof args?.action === "string" ? args.action : undefined;
  const key =
    name === "update_goal" && typeof args?.status === "string"
      ? `status_${args.status}`
      : name === "browser" && action === "act"
        ? browserOperation(args, labels)
        : name === "local_image" && args?.task === "ocr"
          ? "task_ocr"
          : mediaGenerator && args
            ? action?.trim().toLowerCase() || "generate"
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
  if (mediaGenerator && operation === "generate" && phase === "done") {
    phase = completedMediaGenerationPhase(card, name.slice(0, -"_generate".length));
  }
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
