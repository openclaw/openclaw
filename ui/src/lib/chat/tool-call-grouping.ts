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
  const completed = summarizeAgentActivity(
    current.filter((item) => item.status === "completed"),
    options,
  );
  const completedKinds = new Set(
    Object.entries(completed.counts)
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind),
  );
  const otherTools = summary.counts.other
    ? [
        ...new Set(
          current.flatMap((item) =>
            item.name &&
            item.name !== "sessions_spawn" &&
            summarizeAgentActivity([item], options).counts.other
              ? [resolveToolDisplayIdentity(item.name).label]
              : [],
          ),
        ),
      ]
    : [];
  const label = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([kind], index) => {
      const continuation = index > 0 ? "Continuation" : "";
      return kind === "other" && otherTools.length
        ? t(`chat.toolCards.activity.calledTools${continuation}`, { tools: otherTools.join(", ") })
        : t(
            `chat.toolCards.activity.${kind}${completedKinds.has(kind) ? "Summary" : "Pending"}${continuation}`,
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
  return (
    [summary.label, ...summary.outcomes.map(({ label }) => label)].filter(Boolean).join(" · ") ||
    t("chat.toolCards.rawDetails")
  );
}
