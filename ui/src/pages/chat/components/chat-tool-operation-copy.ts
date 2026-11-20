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

// These labels describe the publication, not merely a successful tool call.
const knowledgePublicationTools = new Set([
  "knowledge_annotate",
  "knowledge_correct",
  "knowledge_create_claim",
  "knowledge_create_relationship",
  "knowledge_edit_body",
  "knowledge_extract_section",
  "knowledge_merge",
  "knowledge_publish_batch",
  "knowledge_recall",
  "knowledge_reconcile_evidence",
  "knowledge_resume",
  "knowledge_save_page",
  "knowledge_supersede",
  "knowledge_unmerge",
  "knowledge_withdraw",
]);

function knowledgePublicationQualifier(receipt: Record<string, unknown> | null | undefined) {
  switch (receipt?.state) {
    case "published":
      return undefined;
    case "accepted":
      return "operationPendingPublication";
    case "conflict":
    case "rejected":
      return "operationNotApplied";
    case undefined:
      // Only a published agent receipt omits state and carries the new revision and full hash.
      if (
        typeof receipt?.id === "string" &&
        /^\S{1,96}$/u.test(receipt.id) &&
        typeof receipt.revision === "number" &&
        Number.isSafeInteger(receipt.revision) &&
        receipt.revision > 0 &&
        typeof receipt.hash === "string" &&
        /^[a-f0-9]{64}$/u.test(receipt.hash)
      ) {
        return undefined;
      }
  }
  return "operationUnknown";
}

export function catalogToolOperation(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string },
): { label: string; showOutcome?: true } | undefined {
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
      return { label: t(`chat.toolCards.operationLabels.message.${action}.action`) };
    }
    if (receipt?.changed === false || removed === null || clearCount === 0) {
      return { label: t(`chat.toolCards.operationLabels.message.${action}.unchanged`) };
    }
  }
  if (name === "workboard_board_archive") {
    action = args?.archived === false ? "restore" : undefined;
  } else if (name === "workboard_verify") {
    action = args?.outcome === "confirmed" ? "confirmed" : undefined;
  } else if (name === "lobster" && action === "resume") {
    if (args?.cancel === true) {
      action = "cancel";
    } else if (args?.approve === false) {
      action = "decline";
    }
  }
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
  let operation = key && Object.hasOwn(labels, key) ? key : "default";
  if (name === "knowledge_attach" && args?.final === true) {
    operation = "final";
  } else if (
    (name === "knowledge_relink" || name === "knowledge_reconcile_evidence") &&
    args?.dryRun === true
  ) {
    operation = "preview";
  } else if (name === "knowledge_supersede" && args?.undo === true) {
    operation = "restore";
  }
  if (!Object.hasOwn(labels, operation)) {
    return undefined;
  }
  let qualifier: ReturnType<typeof knowledgePublicationQualifier>;
  let phase =
    outcome === "running"
      ? "running"
      : outcome === "succeeded" && !(name === "message" && args?.dryRun === true)
        ? "done"
        : "action";
  if (mediaGenerator && operation === "generate" && phase === "done") {
    phase = completedMediaGenerationPhase(card, name.slice(0, -"_generate".length));
  }
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
  const remember = name === "knowledge_remember";
  if (phase === "done" && (remember || knowledgePublicationTools.has(name))) {
    // The dispatcher retains the called tool's structured result even when history omits its text.
    const details = asNullableRecord(card.details);
    const structured = asNullableRecord(asNullableRecord(details?.result)?.details) ?? details;
    const result =
      structured &&
      (remember ? "receipt" in structured : "state" in structured || "revision" in structured)
        ? structured
        : safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? ""));
    const receipt = remember ? asNullableRecord(result?.receipt) : result;
    // All duplicates need no publication. An "inserted" item alone does not prove a save.
    const allDuplicates =
      remember &&
      result?.receipt === null &&
      Array.isArray(result.items) &&
      result.items.length > 0 &&
      result.items.every((item: unknown) => asNullableRecord(item)?.status === "duplicate");
    if (name === "knowledge_reconcile_evidence" && receipt?.state === "preview") {
      operation = "preview";
    } else if (!allDuplicates) {
      qualifier =
        operation === "preview" ? "operationUnknown" : knowledgePublicationQualifier(receipt);
      if (qualifier) {
        phase = "action";
      }
    }
  } else if (phase === "done" && (name === "knowledge_relink" || name === "knowledge_verify")) {
    const details = asNullableRecord(card.details);
    const result = {
      ...(asNullableRecord(asNullableRecord(details?.result)?.details) ?? details),
      ...safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? "")),
    };
    if (name === "knowledge_relink") {
      if (result.dryRun === true) {
        operation = "preview";
      } else if (
        operation !== "preview" &&
        typeof result.linked === "number" &&
        result.linked > 0
      ) {
        phase = "linked";
      }
    } else {
      phase =
        result.failed === 0 && typeof result.passed === "number" && result.passed > 0
          ? "done"
          : "checked";
    }
  }
  // Searches and page reads stay distinguishable by what they looked for.
  const input =
    (name === "web_search" || name === "memory_search") && typeof args?.query === "string"
      ? args.query
      : name === "wiki_get" && typeof args?.lookup === "string"
        ? args.lookup
        : undefined;
  const query = input
    ? truncateUtf16WithEllipsis(input.replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, " ").trim(), 120) ||
      undefined
    : undefined;
  const label = t(
    `chat.toolCards.operationLabels.${name}.${operation}.${phase}${query ? "WithQuery" : ""}`,
    query ? { query } : undefined,
  );
  const target =
    name === "nodes" && operation === "describe"
      ? describedNodeName(args?.node, card.details)
      : addressed?.name;
  const named = target
    ? t("chat.toolCards.namedOperation", { action: label, name: target })
    : label;
  // A publication receipt qualifies a completed call; the row's outcome slot covers the rest.
  return qualifier
    ? { label: t(`chat.toolCards.${qualifier}`, { action: named }) }
    : { label: named, showOutcome: true };
}
