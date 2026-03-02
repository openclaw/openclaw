/**
 * Inter-agent messaging store for team runs.
 * Append-only messages stored in the shared team store.
 */

import { randomUUID } from "node:crypto";
import { emitTeamEvent } from "./team-events.js";
import { loadTeamStore, saveTeamStore } from "./team-store.js";
import type { TeamMessage } from "./types.js";

/** Send a message within a team run. */
export function sendTeamMessage(opts: {
  teamRunId: string;
  from: string;
  to: string; // agent ID for DM, "broadcast" for all members
  content: string;
}): TeamMessage {
  const store = loadTeamStore();
  const msg: TeamMessage = {
    id: randomUUID(),
    teamRunId: opts.teamRunId,
    from: opts.from,
    to: opts.to,
    content: opts.content,
    timestamp: Date.now(),
  };
  const bucket = store.messages[opts.teamRunId] ?? [];
  bucket.push(msg);
  store.messages[opts.teamRunId] = bucket;
  saveTeamStore(store);
  emitTeamEvent({
    type: "team_message_sent",
    teamRunId: msg.teamRunId,
    messageId: msg.id,
    from: msg.from,
    to: msg.to,
  });
  return msg;
}

/**
 * Mark messages as read by a specific agent.
 * Sets `readBy[agentId] = Date.now()` on each message that hasn't already been
 * marked read by this agent. Returns the count of newly marked messages.
 */
export function markTeamMessagesRead(
  teamRunId: string,
  agentId: string,
  messageIds: string[],
): number {
  const store = loadTeamStore();
  const bucket = store.messages[teamRunId];
  if (!bucket) {
    return 0;
  }

  const now = Date.now();
  let count = 0;
  const markedIds: string[] = [];

  for (const msg of bucket) {
    if (!messageIds.includes(msg.id)) {
      continue;
    }
    // Initialize readBy map if absent
    if (!msg.readBy) {
      msg.readBy = {};
    }
    // Only mark if this agent hasn't already read the message
    if (msg.readBy[agentId] == null) {
      msg.readBy[agentId] = now;
      count++;
      markedIds.push(msg.id);
    }
  }

  if (count > 0) {
    saveTeamStore(store);
    emitTeamEvent({
      type: "team_messages_read",
      teamRunId,
      agentId,
      messageIds: markedIds,
    });
  }

  return count;
}

/** List messages for a team run, optionally filtered. */
export function listTeamMessages(
  teamRunId: string,
  filter?: {
    from?: string;
    to?: string;
    since?: number; // epoch ms — return messages after this timestamp
  },
): TeamMessage[] {
  const store = loadTeamStore();
  let msgs = store.messages[teamRunId] ?? [];

  if (filter?.from) {
    msgs = msgs.filter((m) => m.from === filter.from);
  }
  if (filter?.to) {
    msgs = msgs.filter((m) => m.to === filter.to);
  }
  if (filter?.since != null) {
    msgs = msgs.filter((m) => m.timestamp > filter.since!);
  }

  // Ascending by timestamp
  msgs.sort((a, b) => a.timestamp - b.timestamp);
  return msgs;
}
