/**
 * Inter-agent messaging store for team runs.
 * SQLite-backed append-only messages.
 */

import { randomUUID } from "node:crypto";
import { emitTeamEvent } from "./team-events.js";
import {
  appendTeamMessageToDb,
  loadTeamMessageByIdFromDb,
  loadTeamMessagesFromDb,
  updateTeamMessageReadByInDb,
} from "./team-store-sqlite.js";
import type { TeamMessage } from "./types.js";

/** Send a message within a team run. */
export function sendTeamMessage(opts: {
  teamRunId: string;
  from: string;
  to: string; // agent ID for DM, "broadcast" for all members
  content: string;
}): TeamMessage {
  const msg: TeamMessage = {
    id: randomUUID(),
    teamRunId: opts.teamRunId,
    from: opts.from,
    to: opts.to,
    content: opts.content,
    timestamp: Date.now(),
  };
  appendTeamMessageToDb(msg);
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
  const now = Date.now();
  let count = 0;
  const markedIds: string[] = [];

  for (const messageId of messageIds) {
    const msg = loadTeamMessageByIdFromDb(teamRunId, messageId);
    if (!msg) {
      continue;
    }

    const readBy = msg.readBy ?? {};
    if (readBy[agentId] != null) {
      continue;
    }

    readBy[agentId] = now;
    updateTeamMessageReadByInDb(teamRunId, messageId, readBy);
    count++;
    markedIds.push(messageId);
  }

  if (count > 0) {
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
  return loadTeamMessagesFromDb(teamRunId, filter);
}
