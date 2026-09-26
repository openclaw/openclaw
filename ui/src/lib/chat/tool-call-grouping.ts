/**
 * Aggregate summaries for a run of consecutive tool calls, e.g.
 * "Ran 13 commands, read 6 files, edited 9 files, created a file".
 */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import { t } from "../../i18n/index.ts";

export function readPreparedActivity(message: unknown): AgentActivityItem[] {
  const activity = asOptionalRecord(message)?.activity;
  return Array.isArray(activity)
    ? activity.filter((item): item is AgentActivityItem =>
        Value.Check(AgentActivityItemSchema, item),
      )
    : [];
}

export function describeToolGroup(items: readonly AgentActivityItem[]) {
  const summary = summarizeAgentActivity(items);
  const label = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) =>
      t(`chat.toolCards.activity.${kind}${count === 1 ? "One" : "Many"}`, { count: String(count) }),
    )
    .join(" · ");
  const outcomes = Object.entries(summary.outcomes)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      kind,
      label: t(`chat.toolCards.activity.${kind}`, { count: String(count) }),
    }));
  return { total: summary.total, label, outcomes };
}

export function summarizeToolGroup(
  items: readonly AgentActivityItem[],
  options: { includeFailureCount?: boolean } = {},
): string {
  const summary = describeToolGroup(items);
  return (
    [
      summary.label,
      ...summary.outcomes
        .filter(({ kind }) => options.includeFailureCount !== false || kind !== "failed")
        .map(({ label }) => label),
    ]
      .filter(Boolean)
      .join(" · ") || t("chat.toolCards.rawDetails")
  );
}
