import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../i18n/index.ts";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";
import { isAgentActivityItem } from "../protocol-validators.generated/activity.js";
import { resolveToolDisplayIdentity } from "./tool-display-identity.ts";

registerChatToolLabelsEnglish();

export function readPreparedActivity(message: unknown): AgentActivityItem[] {
  const activity = asOptionalRecord(message)?.activity;
  return Array.isArray(activity) ? activity.filter(isAgentActivityItem) : [];
}

export function hasVisiblePreparedActivity(message: unknown): boolean {
  return readPreparedActivity(message).some(
    (activity) => !activity.hideFromChannelProgress && !activity.suppressChannelProgress,
  );
}

type ToolGroupOptions = {
  /** Calls of launches that opened a session in its own right, not a subagent. */
  ownSessionLaunches?: ReadonlySet<string>;
  activityKeys?: ReadonlyMap<AgentActivityItem, string>;
  /** Canonical command results with an exit code prove execution, including nonzero exits. */
  executedCommands?: ReadonlySet<string>;
  /** Executions with source but no shell command have their own factual category. */
  codeExecutions?: ReadonlySet<string>;
};

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
  const current = [
    ...new Map(
      scoped
        .filter((item) => !item.suppressChannelProgress)
        .map((item) => [item.toolCallId ?? item.itemId, item]),
    ).values(),
  ];
  const summary = summarizeAgentActivity(current, options);
  const code = current.filter(
    (item) =>
      !item.hideFromChannelProgress && options.codeExecutions?.has(item.toolCallId ?? item.itemId),
  );
  const codeIds = new Set(code.map((item) => item.toolCallId ?? item.itemId));
  const skillSearches = current.filter(
    (item) => !item.hideFromChannelProgress && item.name === "skills_search",
  );
  const skillReads = current.filter(
    (item) => !item.hideFromChannelProgress && item.name === "skills_read",
  );
  const skillItems = new Set([...skillSearches, ...skillReads]);
  const ordinary = current.filter(
    (item) => !codeIds.has(item.toolCallId ?? item.itemId) && !skillItems.has(item),
  );
  const { other, subagents, ...categories } = summarizeAgentActivity(ordinary, options).counts;
  const counts = {
    code: code.length,
    ...categories,
    skillSearches: skillSearches.length,
    skillReads: skillReads.length,
    other,
    subagents,
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
        ordinary.filter((item) => item.status === "running"),
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
  if (
    code.some(
      (item) =>
        item.status === "completed" ||
        (item.status !== "blocked" &&
          item.status !== "skipped" &&
          options.executedCommands?.has(item.toolCallId ?? item.itemId)),
    )
  ) {
    completedKinds.add("code");
  }
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
      if (kind === "skillSearches" || kind === "skillReads") {
        const skills = kind === "skillSearches" ? skillSearches : skillReads;
        const phase = skills.some((item) => item.status === "running")
          ? "Running"
          : skills.some((item) => item.status === "completed")
            ? "Summary"
            : "Pending";
        return t(`chat.toolCards.activity.${kind}${phase}${continuation}`);
      }
      if (kind === "code") {
        return t(
          `chat.toolCards.${code.some((item) => item.status === "running") ? "executingCode" : completedKinds.has(kind) ? "executedCode" : "codeExecution"}${continuation}`,
        );
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
