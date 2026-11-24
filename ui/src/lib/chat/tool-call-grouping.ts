import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../i18n/index.ts";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";

export { readPreparedActivity, hasVisiblePreparedActivity } from "./prepared-activity.ts";

registerChatToolLabelsEnglish();

type ToolGroupOptions = {
  /** Calls of launches that opened a session in its own right, not a subagent. */
  ownSessionLaunches?: ReadonlySet<string>;
  activityKeys?: ReadonlyMap<AgentActivityItem, string>;
  /** Exit codes or code-mode bridge dispatch receipts prove execution, not success. */
  executedCommands?: ReadonlySet<string>;
  /** Visible operations whose enclosing execution is still producing children. */
  continuingExecutions?: ReadonlySet<string>;
  /** True only when the cancellation receipt confirms that its target was cancelled. */
  subagentCancellations?: ReadonlyMap<string, boolean>;
  /** Cancelled run context for calls that have no result of their own. */
  interruptedCalls?: ReadonlySet<string>;
};

const MEMORY_UPDATE_TOOLS = new Set([
  "knowledge_remember",
  "knowledge_edit_body",
  "knowledge_save_page",
  "knowledge_create_claim",
]);

// Summary categories describe work across tools. Unknown names share one fallback;
// display names and identifiers belong to the expanded operation rows.
const SUMMARY_TOOL_KINDS = new Map([
  ["skills_read", "reads"],
  ["skills_search", "searches"],
  ["memory_search", "searches"],
  ["knowledge_grep", "searches"],
  ["memory_get", "memory"],
  ["knowledge_record", "memory"],
  ["knowledge_records", "memory"],
  ["knowledge_lookup", "memory"],
  ...[...MEMORY_UPDATE_TOOLS].map((name) => [name, "memory"] as const),
  ["sessions_send", "messages"],
  ["conversations_send", "messages"],
  ["agents_wait", "waits"],
  ["ask_user", "questions"],
]);

export function describeToolGroup(
  items: readonly AgentActivityItem[],
  options: ToolGroupOptions = {},
) {
  const scoped = options.activityKeys
    ? items.map((item) => {
        const key = options.activityKeys!.get(item);
        return key ? { ...item, itemId: key, toolCallId: key } : item;
      })
    : items;
  const all = [
    ...new Map(
      scoped
        .filter((item) => !item.suppressChannelProgress)
        .map((item) => [item.toolCallId ?? item.itemId, item]),
    ).values(),
  ];
  const summary = summarizeAgentActivity(all, options);
  const groups = new Map<string, AgentActivityItem[]>(
    [
      "reads",
      "changes",
      "commands",
      "searches",
      "fetches",
      "memory",
      "messages",
      "waits",
      "questions",
      "cancellations",
      "other",
      "subagents",
      "interrupted",
    ].map((kind) => [kind, []]),
  );
  for (const item of all) {
    const key = item.toolCallId ?? item.itemId;
    if (options.interruptedCalls?.has(key)) {
      groups.get("interrupted")!.push(item);
      continue;
    }
    if (item.hideFromChannelProgress) {
      continue;
    }
    const name = item.name?.trim().toLowerCase() ?? "";
    const kind = options.subagentCancellations?.has(key)
      ? "cancellations"
      : item.commandBearing
        ? "commands"
        : (SUMMARY_TOOL_KINDS.get(name) ??
          Object.entries(summarizeAgentActivity([item], options).counts).find(
            ([, count]) => count > 0,
          )![0]);
    groups.get(kind === "edits" || kind === "writes" ? "changes" : kind)!.push(item);
  }
  const isRunning = (item: AgentActivityItem) =>
    item.status === "running" || options.continuingExecutions?.has(item.toolCallId ?? item.itemId);
  const isCompleted = (item: AgentActivityItem) =>
    item.status === "completed" ||
    (item.status !== "blocked" &&
      item.status !== "skipped" &&
      options.executedCommands?.has(item.toolCallId ?? item.itemId));
  const phaseOf = (actions: AgentActivityItem[]) =>
    actions.some(isRunning) ? "Running" : actions.some(isCompleted) ? "Summary" : "Pending";
  const fileReads = groups.get("reads")!;
  const fileChanges = groups.get("changes")!;
  const hasFileWork = fileReads.length > 0 || fileChanges.length > 0;
  // Combine the same kind of work only when both verbs describe the recorded state.
  const combineFiles =
    fileReads.length > 0 && fileChanges.length > 0 && phaseOf(fileReads) === phaseOf(fileChanges);
  const meaningfulWork = [...groups].some(([kind, actions]) => kind !== "other" && actions.length);
  const label = [...groups]
    .filter(([kind, actions]) => actions.length > 0 && !(combineFiles && kind === "changes"))
    .filter(([kind, actions]) => {
      // Completed discovery supports file work; active, uncertain and write operations
      // retain their own labels. Every operation remains in the expanded group.
      if (!actions.every((item) => isCompleted(item) && !isRunning(item))) {
        return true;
      }
      if (kind === "other") {
        return !meaningfulWork;
      }
      return (
        !hasFileWork ||
        (kind !== "searches" &&
          (kind !== "memory" ||
            actions.some((item) => MEMORY_UPDATE_TOOLS.has(item.name?.trim().toLowerCase() ?? ""))))
      );
    })
    .map(([kind, actions], index) => {
      const continuation = index > 0 ? "Continuation" : "";
      if (kind === "interrupted") {
        return t("chat.toolCards.activity.interrupted" + continuation);
      }
      if (kind === "cancellations") {
        const phase = actions.some(isRunning)
          ? "Running"
          : actions.some((item) =>
                options.subagentCancellations?.get(item.toolCallId ?? item.itemId),
              )
            ? "Summary"
            : "Pending";
        return t("chat.toolCards.activity.cancellations" + phase + continuation);
      }
      if (kind === "memory") {
        const reads = actions.filter(
          (item) => !MEMORY_UPDATE_TOOLS.has(item.name?.trim().toLowerCase() ?? ""),
        );
        const updates = actions.filter((item) =>
          MEMORY_UPDATE_TOOLS.has(item.name?.trim().toLowerCase() ?? ""),
        );
        const key = updates.some(isRunning)
          ? "memoryUpdatesRunning"
          : reads.some(isRunning)
            ? "memoryReadsRunning"
            : updates.some(isCompleted)
              ? reads.some(isCompleted)
                ? "memoryReadUpdatesSummary"
                : "memoryUpdatesSummary"
              : reads.some(isCompleted)
                ? "memoryReadsSummary"
                : "memoryPending";
        return t(`chat.toolCards.activity.${key}${continuation}`);
      }
      const phase =
        kind === "subagents"
          ? actions.some(isCompleted)
            ? "Summary"
            : "Pending"
          : phaseOf(actions);
      const labelKind = combineFiles && kind === "reads" ? "readChanges" : kind;
      return t(`chat.toolCards.activity.${labelKind}${phase}${continuation}`);
    })
    .join(", ");
  // Attempt outcomes remain on their rows. They do not establish the result
  // of a whole group, nor whether another call recovered from an earlier one.
  const outcomes = Object.entries(summary.outcomes)
    .filter(([kind, count]) => count > 0 && kind !== "failed" && kind !== "skipped")
    .map(([kind]) => ({
      kind,
      label: t(`chat.toolCards.activity.${kind}Summary`),
    }));
  return { total: summary.total, label, outcomes };
}

/** The compact summary names the work and keeps non-success visible without counters. */
export function summarizeToolGroup(
  items: readonly AgentActivityItem[],
  options: ToolGroupOptions = {},
): string {
  const summary = describeToolGroup(items, options);
  return [summary.label, ...summary.outcomes.map(({ label }) => label)].filter(Boolean).join(" · ");
}
