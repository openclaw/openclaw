import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../i18n/index.ts";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";
import { resolveToolDisplayIdentity } from "./tool-display-identity.ts";

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

/** Actions named by their purpose rather than counted in a generic category. */
const SEMANTIC_TOOL_KINDS = {
  skillSearches: "skills_search",
  skillReads: "skills_read",
  waits: "agents_wait",
  questions: "ask_user",
} as const;

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
  const current = all.filter(
    (item) => !options.interruptedCalls?.has(item.toolCallId ?? item.itemId),
  );
  const summary = summarizeAgentActivity(all, options);
  const semantic = new Map(
    Object.entries(SEMANTIC_TOOL_KINDS).map(([kind, name]) => [
      kind,
      current.filter((item) => !item.hideFromChannelProgress && item.name === name),
    ]),
  );
  const cancellations = current.filter(
    (item) =>
      !item.hideFromChannelProgress &&
      options.subagentCancellations?.has(item.toolCallId ?? item.itemId),
  );
  const semanticItems = new Set([...[...semantic.values()].flat(), ...cancellations]);
  const ordinary = current.filter((item) => !semanticItems.has(item));
  const { other, subagents, ...categories } = summarizeAgentActivity(ordinary, options).counts;
  const counts = {
    ...categories,
    ...Object.fromEntries([...semantic].map(([kind, actions]) => [kind, actions.length])),
    cancellations: cancellations.length,
    other,
    subagents,
    interrupted: all.length - current.length,
  };
  const completed = summarizeAgentActivity(
    ordinary.filter(
      (item) =>
        item.status === "completed" ||
        (item.status !== "blocked" &&
          item.status !== "skipped" &&
          options.executedCommands?.has(item.toolCallId ?? item.itemId)),
    ),
    options,
  );
  const runningKinds = new Set(
    Object.entries(
      summarizeAgentActivity(
        ordinary.filter(
          (item) =>
            item.status === "running" ||
            options.continuingExecutions?.has(item.toolCallId ?? item.itemId),
        ),
        options,
      ).counts,
    )
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind),
  );
  const completedKinds = new Set(
    Object.entries(completed.counts)
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind),
  );
  const otherTools = counts.other
    ? [
        ...new Set(
          ordinary.flatMap((item) =>
            item.name &&
            item.name !== "sessions_spawn" &&
            summarizeAgentActivity([item], options).counts.other
              ? [resolveToolDisplayIdentity(item.name).label]
              : [],
          ),
        ),
      ]
    : [];
  const label = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind], index) => {
      const continuation = index > 0 ? "Continuation" : "";
      const actions = semantic.get(kind);
      if (actions) {
        const phase = actions.some((item) => item.status === "running")
          ? "Running"
          : actions.some((item) => item.status === "completed")
            ? "Summary"
            : "Pending";
        return t(`chat.toolCards.activity.${kind}${phase}${continuation}`);
      }
      if (kind === "interrupted") {
        return t("chat.toolCards.activity.interrupted" + continuation);
      }
      if (kind === "cancellations") {
        const phase = cancellations.some((item) => item.status === "running")
          ? "Running"
          : cancellations.some((item) =>
                options.subagentCancellations?.get(item.toolCallId ?? item.itemId),
              )
            ? "Summary"
            : "Pending";
        return t("chat.toolCards.activity.cancellations" + phase + continuation);
      }
      return kind === "other" && otherTools.length
        ? t(
            `chat.toolCards.activity.${runningKinds.has(kind) ? "callingTools" : "calledTools"}${continuation}`,
            { tools: otherTools.join(", ") },
          )
        : t(
            `chat.toolCards.activity.${kind}${runningKinds.has(kind) && kind !== "subagents" ? "Running" : completedKinds.has(kind) ? "Summary" : "Pending"}${continuation}`,
          );
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
