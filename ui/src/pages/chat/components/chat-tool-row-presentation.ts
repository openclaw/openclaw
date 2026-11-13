import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import type { ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionLaunchPresentation } from "../chat-spawned-subagent.ts";

registerChatToolLabelsEnglish();

const TOOL_ROW_VERB_KEYS = {
  read: ["reading", "read", "readFailed", "read"],
  search: ["searching", "searched", "searchFailed", "search"],
  fetch: ["fetching", "fetched", "fetchFailed", "fetch"],
} as const;

const MUTATION_VERB_KEYS = {
  update: ["editing", "edited", "edit"],
  add: ["creating", "created", "create"],
  delete: ["deleting", "deleted", "delete"],
  mixed: ["changing", "changed", "change"],
  write: ["writing", "wrote", "write"],
} as const;

export function resolveToolRowVerb(
  view: Pick<ToolCallView, "kind" | "fileOperations">,
  outcome: ToolCardOutcome,
): string | undefined {
  let mutation: keyof typeof MUTATION_VERB_KEYS | undefined;
  if (view.kind === "write") {
    mutation = "write";
  } else if (view.kind === "edit") {
    const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
    mutation = operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
  }
  if (mutation) {
    const [running, succeeded, fallback] = MUTATION_VERB_KEYS[mutation];
    return t(
      `chat.toolCards.verbs.${outcome === "running" ? running : outcome === "succeeded" ? succeeded : fallback}`,
    );
  }
  if (view.kind === "read" || view.kind === "search" || view.kind === "fetch") {
    const [running, succeeded, failed, fallback] = TOOL_ROW_VERB_KEYS[view.kind];
    return t(
      `chat.toolCards.verbs.${outcome === "running" ? running : outcome === "succeeded" ? succeeded : outcome === "failed" ? failed : fallback}`,
    );
  }
  return undefined;
}

export function commandPreview(command: string): string {
  return truncateUtf16Safe(command.replace(/\s+/gu, " ").trim(), 200);
}

/** The title describes recorded action and target; authored purpose stays in input details. */
export function resolveToolOperationLabel(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string },
  detail = card.activity?.meta,
): string {
  const launch = resolveSessionLaunchPresentation(card, outcome);
  if (launch) {
    return [
      t(`chat.toolCards.launch.${launch.kind}.${launch.phase}`),
      addressed?.name ?? launch.label,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const call = unwrapToolCallForDisplay(card);
  const args = asNullableRecord(call.args);
  const input = resolveToolCallInput(call.name, args);
  if (input.kind === "command") {
    const command = typeof args?.command === "string" ? args.command : undefined;
    if (command?.trim()) {
      return `$ ${commandPreview(command)}`;
    }
    return t(
      `chat.toolCards.${outcome === "running" ? "executingCode" : outcome === "succeeded" ? "executedCode" : "codeExecution"}`,
    );
  }
  const verb = resolveToolRowVerb(input, outcome);
  const target =
    input.kind === "fetch"
      ? input.url
      : input.kind === "search" && input.pattern
        ? input.pattern
        : input.path && pathDisplayName(input.path);
  if (verb && target) {
    return `${verb} ${target}`;
  }
  const display = resolveToolDisplayIdentity(call.name);
  const name = call.name.trim().toLowerCase();
  const sessionLabel =
    name === "sessions_history"
      ? outcome === "running"
        ? "readingChat"
        : outcome === "succeeded"
          ? "readChat"
          : "chatRead"
      : name === "sessions_search"
        ? outcome === "running"
          ? "searchingChats"
          : outcome === "succeeded"
            ? "searchedChats"
            : "chatSearch"
        : undefined;
  return [
    sessionLabel ? t(`chat.toolCards.${sessionLabel}`) : display.label,
    addressed ? addressed.name : detail,
  ]
    .filter(Boolean)
    .join(" ");
}
