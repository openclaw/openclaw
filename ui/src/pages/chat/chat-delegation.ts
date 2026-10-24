import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isDashboardSessionKey } from "../../lib/sessions/session-key.ts";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import {
  endedWithoutFinishing,
  isUnfinishedSubagent,
  readAcceptedSubagentLaunch,
} from "./chat-spawned-subagent.ts";
import type { SystemEventRenderItem } from "./chat-system-event-grouping.ts";
import { createToolCallLookup } from "./chat-thread-run-identity.ts";
import { createTranscriptMemo } from "./components/chat-transcript-memo.ts";

export type DelegatedTask = {
  runId: string;
  childSessionKey: string;
  label: string;
  status: "accepted" | "queued" | "running" | "done" | "failed" | "killed" | "timeout" | "unknown";
  runtimeMs?: number;
  listed: boolean;
};
export type DelegatedTaskGroup = { key: string; tasks: DelegatedTask[] };
type Receipt = NonNullable<AgentActivityItem["delegation"]>[number];
const projections = createTranscriptMemo<Map<string, DelegatedTaskGroup[]>>();
type Launch = { owner: string; receipt: Receipt };
type Facts = { launches: Launch[]; completions: Map<string, Receipt> };
const factsMemo = createTranscriptMemo<Facts>();
const receiptKey = (receipt: Pick<Receipt, "runId" | "childSessionKey">) =>
  JSON.stringify([receipt.runId, receipt.childSessionKey]);

/** Accepted launches own placement; later collection receipts only update their outcome. */
function collectFacts(
  items: readonly SystemEventRenderItem[],
  messages: readonly unknown[],
): Facts {
  return factsMemo(items, [messages], () => {
    const launches: Launch[] = [];
    const completions = new Map<string, Receipt>();
    // Routine waits may disappear from the rendered chain, but their durable outcomes still count.
    for (const message of messages) {
      for (const activity of readPreparedActivity(message)) {
        for (const receipt of activity.delegation ?? []) {
          if (receipt.status !== "accepted") {
            completions.set(receiptKey(receipt), receipt);
          }
        }
      }
    }
    const calls = createToolCallLookup<ToolCard>();
    const seen = new Set<string>();
    for (const item of items) {
      for (const group of chatItemGroups(item)) {
        for (const { message } of group.messages) {
          const cards = extractToolCardsCached(message);
          for (const card of cards) {
            if (card.args) {
              calls.add(card.runId ?? group.runId, card.callId, card);
            }
          }
          const receipts = readPreparedActivity(message).flatMap(
            (activity) => activity.delegation ?? [],
          );
          // Shipped direct tool results retain their structured accepted identity as JSON.
          // Nested calls use the producer's prepared receipt, never free-form source parsing.
          for (const card of cards) {
            const call = calls.get(card.runId ?? group.runId, card.callId);
            const accepted = readAcceptedSubagentLaunch({ ...card, args: card.args ?? call?.args });
            if (accepted) {
              receipts.push(accepted);
            }
          }
          for (const receipt of receipts) {
            const key = receiptKey(receipt);
            if (receipt.status !== "accepted") {
              completions.set(key, receipt);
            } else if (!isDashboardSessionKey(receipt.childSessionKey) && !seen.has(key)) {
              seen.add(key);
              launches.push({ owner: item.key, receipt });
            }
          }
        }
      }
    }
    return { launches, completions };
  });
}

/** No origin in the loaded history means no placement, not a guess at the latest turn. */
export function projectDelegatedTasks(
  items: readonly SystemEventRenderItem[],
  children: readonly GatewaySessionRow[] | undefined,
  summary: GatewaySessionRow["swarm"],
  messages: readonly unknown[],
): Map<string, DelegatedTaskGroup[]> {
  const facts = collectFacts(items, messages);
  return projections(facts, [children, summary], () => {
    const rows = new Map(children?.map((row) => [row.key, row]));
    const statuses = new Map(
      summary?.groups
        .flatMap((group) => group.children ?? [])
        .map((child) => [child.sessionKey, child.status]),
    );
    const owners = new Map<string, Map<string, DelegatedTaskGroup>>();
    for (const { owner, receipt } of facts.launches) {
      const terminal = facts.completions.get(receiptKey(receipt));
      const row = rows.get(receipt.childSessionKey);
      const sameRun =
        row && (row.lastRunId === receipt.runId || row.activeRunIds?.includes(receipt.runId));
      const status =
        terminal?.status ??
        statuses.get(receipt.childSessionKey) ??
        (sameRun && !receipt.groupId
          ? isUnfinishedSubagent(row)
            ? "running"
            : endedWithoutFinishing(row)
              ? "failed"
              : row.status === "done"
                ? "done"
                : "accepted"
          : row
            ? "accepted"
            : "unknown");
      const groups = owners.get(owner) ?? new Map<string, DelegatedTaskGroup>();
      const groupKey = receipt.groupId ?? owner;
      const group = groups.get(groupKey) ?? { key: JSON.stringify([owner, groupKey]), tasks: [] };
      group.tasks.push({
        runId: receipt.runId,
        childSessionKey: receipt.childSessionKey,
        label: resolveSessionDisplayName(receipt.childSessionKey, {
          ...row,
          label: row?.label ?? receipt.label,
        }),
        status,
        runtimeMs:
          terminal?.runtimeMs ??
          row?.runtimeMs ??
          (row?.startedAt != null && row?.endedAt != null
            ? Math.max(0, row.endedAt - row.startedAt)
            : undefined),
        listed: row !== undefined,
      });
      groups.set(groupKey, group);
      owners.set(owner, groups);
    }
    return new Map([...owners].map(([owner, groups]) => [owner, [...groups.values()]]));
  });
}
