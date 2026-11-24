import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import type { IconName } from "../../../components/icon-data.ts";
import { registerChatToolOperationsEnglish } from "../../../i18n/locales/en-chat-tool-operations.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatToolOperationsEnglish);

const catalog: Readonly<Record<string, object>> =
  registerChatToolOperationsEnglish.catalog.chat.toolCards.operationLabels;

const operationIcons = new Map<string, IconName>([
  ["automations", "calendarClock"],
  ["openclaw", "settings"],
  ["structured_output", "braces"],
  ["dispatch_action", "zap"],
  ["tool_call", "puzzle"],
  ["tool_call_update", "puzzle"],
  ["autoreview", "fileDiff"],
  ["github_read", "github"],
  ["github_search", "github"],
  ["llm-task", "braces"],
  ["lobster", "workflow"],
  ["mcp_events", "activity"],
  ["node_inference", "server"],
  ["onepassword", "key"],
  ["visitor_invite", "userPlus"],
  ["visitor_revoke", "userPlus"],
  ["visitor_list", "userPlus"],
  ["workboard_list", "kanban"],
  ["workboard_create", "kanban"],
  ["workboard_link", "kanban"],
  ["workboard_read", "kanban"],
  ["workboard_claim", "kanban"],
  ["workboard_heartbeat", "kanban"],
  ["workboard_complete", "kanban"],
  ["workboard_attachment_add", "kanban"],
  ["workboard_attachment_read", "kanban"],
  ["workboard_attachment_delete", "kanban"],
  ["workboard_block", "kanban"],
  ["workboard_boards", "kanban"],
  ["workboard_board_create", "kanban"],
  ["workboard_board_archive", "kanban"],
  ["workboard_board_delete", "kanban"],
  ["workboard_sessions_board_read", "kanban"],
  ["workboard_sessions_board_update", "kanban"],
  ["workboard_sessions_board_move", "kanban"],
  ["workboard_stats", "kanban"],
  ["workboard_runs", "kanban"],
  ["workboard_specify", "kanban"],
  ["workboard_decompose", "kanban"],
  ["workboard_notify_subscribe", "kanban"],
  ["workboard_notify_list", "kanban"],
  ["workboard_notify_events", "kanban"],
  ["workboard_notify_advance", "kanban"],
  ["workboard_notify_unsubscribe", "kanban"],
  ["workboard_promote", "kanban"],
  ["workboard_reassign", "kanban"],
  ["workboard_reclaim", "kanban"],
  ["workboard_dispatch", "kanban"],
  ["workboard_release", "kanban"],
  ["workboard_comment", "kanban"],
  ["workboard_proof", "kanban"],
  ["workboard_verify", "kanban"],
  ["workboard_worker_log", "kanban"],
  ["workboard_protocol_violation", "kanban"],
  ["workboard_unblock", "kanban"],
  ["workboard_move", "kanban"],
  ["memory_search", "brain"],
  ["personal_instructions", "fileText"],
  ["knowledge_annotate", "book"],
  ["knowledge_attach", "book"],
  ["knowledge_attach_file", "book"],
  ["knowledge_attachment", "book"],
  ["knowledge_chronicle_day", "book"],
  ["knowledge_chronicle_last_seen", "book"],
  ["knowledge_chronicle_since", "book"],
  ["knowledge_connections", "book"],
  ["knowledge_correct", "book"],
  ["knowledge_create_claim", "book"],
  ["knowledge_create_relationship", "book"],
  ["knowledge_diagnostics", "book"],
  ["knowledge_edit_body", "book"],
  ["knowledge_evidence_read", "book"],
  ["knowledge_extract_section", "book"],
  ["knowledge_grep", "book"],
  ["knowledge_history", "book"],
  ["knowledge_lookup", "book"],
  ["knowledge_merge", "book"],
  ["knowledge_mutation", "book"],
  ["knowledge_ontology", "book"],
  ["knowledge_publish_batch", "book"],
  ["knowledge_recall", "book"],
  ["knowledge_reconcile_evidence", "book"],
  ["knowledge_record", "book"],
  ["knowledge_records", "book"],
  ["knowledge_relink", "book"],
  ["knowledge_remember", "book"],
  ["knowledge_resume", "book"],
  ["knowledge_revision", "book"],
  ["knowledge_save_page", "book"],
  ["knowledge_source_check", "book"],
  ["knowledge_status", "book"],
  ["knowledge_supersede", "book"],
  ["knowledge_timeline", "book"],
  ["knowledge_unmerge", "book"],
  ["knowledge_verify", "book"],
  ["knowledge_withdraw", "book"],
  ["intent", "brain"],
  ["memory_forget", "brain"],
  ["memory_recall", "brain"],
  ["memory_store", "brain"],
  ["wiki_apply", "book"],
  ["wiki_get", "book"],
  ["wiki_lint", "book"],
  ["wiki_search", "book"],
  ["wiki_status", "book"],
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

function browserOperation(args: Record<string, unknown> | null): string {
  const kind = asNullableRecord(args?.request)?.kind ?? args?.kind;
  if (typeof kind !== "string") {
    return "act";
  }
  const key = `act_${kind}`;
  return Object.hasOwn(catalog.browser, key) ? key : "act";
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
  const labels = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!labels) {
    return undefined;
  }
  const action = typeof args?.action === "string" ? args.action : undefined;
  const key =
    name === "update_goal" && typeof args?.status === "string"
      ? `status_${args.status}`
      : name === "browser" && action === "act"
        ? browserOperation(args)
        : name === "local_image" && args?.task === "ocr"
          ? "task_ocr"
          : action?.replaceAll(".", "_");
  const operation = key && Object.hasOwn(labels, key) ? key : "default";
  if (!Object.hasOwn(labels, operation)) {
    return undefined;
  }
  const phase =
    outcome === "running"
      ? "running"
      : outcome === "succeeded" && !(name === "message" && args?.dryRun === true)
        ? "done"
        : "action";
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
