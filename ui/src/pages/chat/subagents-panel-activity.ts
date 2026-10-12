import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { summarizeAgentActivity } from "../../../../src/agents/agent-activity-presentation.js";
import type { SidebarToolActivity } from "../../components/app-sidebar-session-types.ts";
import { readSidebarToolActivity } from "../../components/sidebar-tool-activity.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../lib/chat/tool-display.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

export type SubagentActivitySnapshot = {
  calls: Map<string, AgentActivityItem>;
  complete: boolean;
  tool?: SidebarToolActivity;
};

export function readSubagentToolEvent(
  stream: unknown,
  value: unknown,
  previous?: AgentActivityItem,
): AgentActivityItem | undefined {
  const data = asOptionalRecord(value);
  if (stream === "item") {
    const candidate = Value.Clean(AgentActivityItemSchema, { ...data });
    if (!Value.Check(AgentActivityItemSchema, candidate) || candidate.kind !== "tool") {
      return undefined;
    }
    return candidate.suppressChannelProgress && previous ? previous : candidate;
  }
  const name = (typeof data?.name === "string" ? data.name.trim() : "") || previous?.name;
  if (stream !== "tool" || typeof data?.toolCallId !== "string" || !data.toolCallId || !name) {
    return undefined;
  }
  if (data.suppressChannelProgress === true && previous) {
    return previous;
  }
  return {
    ...previous,
    itemId: previous?.itemId ?? data.toolCallId,
    toolCallId: data.toolCallId,
    kind: "tool",
    name,
    title: resolveToolDisplay({ name }).label,
    phase: data.phase === "result" ? "end" : data.phase === "start" ? "start" : "update",
    ...(data.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
    ...(data.suppressChannelProgress === true ? { suppressChannelProgress: true } : {}),
  };
}

export function readSubagentActivitySnapshot(history: ChatHistoryResult): SubagentActivitySnapshot {
  const messages = history.messages ?? [];
  const entries = messages.map((message) => ({
    cards: extractToolCardsCached(message),
    refs: extractToolMessageRefs(message),
    runId:
      readSessionMessageIdentity(message)?.runId ??
      normalizeOptionalString(asOptionalRecord(message)?.runId),
    activity: Array.isArray(asOptionalRecord(message)?.activity)
      ? readPreparedActivity(message)
      : undefined,
  }));
  let identifiable = true;
  const scopedIdentity = (
    entry: (typeof entries)[number],
    id: string | undefined,
    explicitRunId?: string,
  ): string | undefined => {
    if (!id?.trim()) {
      identifiable = false;
      return undefined;
    }
    const owners = new Set(
      entry.refs.flatMap((ref) => (ref.id === id && ref.runId ? [ref.runId] : [])),
    );
    const runId = explicitRunId ?? (owners.size === 1 ? [...owners][0] : entry.runId);
    if (!runId || (!explicitRunId && owners.size > 1)) {
      identifiable = false;
      return undefined;
    }
    return buildToolStreamIdentity(runId, id);
  };
  const preparedCallIds = new Set(
    entries.flatMap((entry) =>
      entry.activity === undefined
        ? []
        : [
            ...entry.cards.flatMap((card) =>
              card.callId ? [scopedIdentity(entry, card.callId, card.runId)] : [],
            ),
            ...entry.activity
              .filter((item) => item.kind === "tool")
              .map((item) => scopedIdentity(entry, item.toolCallId)),
          ],
    ),
  );
  const calls = new Map<string, AgentActivityItem>();
  let tool: SidebarToolActivity | undefined;
  for (const entry of entries) {
    const { cards, activity } = entry;
    if (activity !== undefined) {
      for (const item of activity) {
        if (item.kind !== "tool") {
          continue;
        }
        const id = scopedIdentity(entry, item.toolCallId);
        if (id) {
          calls.set(id, readSubagentToolEvent("item", item, calls.get(id)) ?? item);
        }
        const next = readSidebarToolActivity("item", item, tool);
        if (next !== undefined) {
          tool = next ?? undefined;
        }
      }
      continue;
    }
    for (const card of cards) {
      if (!card.callId) {
        // Legacy unkeyed calls cannot be reconciled with a later result or replay.
        identifiable = false;
        continue;
      }
      const identity = scopedIdentity(entry, card.callId, card.runId);
      if (!identity) {
        tool = { name: card.name, toolCallId: card.callId };
        continue;
      }
      if (preparedCallIds.has(identity)) {
        continue;
      }
      const outcome = resolveToolCardOutcome(card, false);
      const item: AgentActivityItem = {
        itemId: card.callId,
        toolCallId: card.callId,
        kind: "tool",
        name: card.name,
        title: resolveToolDisplay({ name: card.name }).label,
        phase: "end",
        status: outcome === "succeeded" ? "completed" : outcome === "unknown" ? undefined : outcome,
      };
      calls.set(identity, item);
      tool = { name: card.name, toolCallId: card.callId };
    }
  }
  for (const event of history.inFlightRun?.events ?? []) {
    const id = event.data.toolCallId;
    const identity = typeof id === "string" ? buildToolStreamIdentity(event.runId, id) : undefined;
    const item = readSubagentToolEvent(
      event.stream,
      event.data,
      identity ? calls.get(identity) : undefined,
    );
    if (item) {
      if (!item.toolCallId?.trim()) {
        identifiable = false;
      } else {
        calls.set(buildToolStreamIdentity(event.runId, item.toolCallId), item);
      }
    }
    const next = readSidebarToolActivity(event.stream, event.data, tool);
    if (next !== undefined) {
      tool = next ?? undefined;
    }
  }
  return {
    calls,
    // Ordinary history carries a raw-message total; native imports can instead
    // certify completeness after their own projection. Never count a tail as a total.
    complete:
      identifiable &&
      (history.completeSnapshot === true ||
        (history.hasMore === false &&
          (history.offset ?? 0) === 0 &&
          history.totalMessages === messages.length)),
    tool,
  };
}

export function subagentToolCallCount(snapshot: SubagentActivitySnapshot): number | undefined {
  return snapshot.complete
    ? summarizeAgentActivity(
        Array.from(snapshot.calls, ([identity, item]) =>
          Object.assign({}, item, { toolCallId: identity }),
        ),
      ).total
    : undefined;
}
