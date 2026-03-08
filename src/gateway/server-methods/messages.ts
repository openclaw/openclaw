/**
 * messages.ts — Gateway RPC handlers for the message_log database.
 *
 * messages.list:  Paginated query with optional filters (session, channel, sender, search).
 * messages.stats: Aggregate statistics (counts by channel, direction, sender).
 */

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { queryMessages } from "../../memory/message-logger.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export const messagesHandlers: GatewayRequestHandlers = {
  "messages.list": async ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "main";
    const { cfg } = loadSessionEntry(sessionKey);
    if (!cfg) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "config not found"));
      return;
    }

    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "memory manager unavailable"),
      );
      return;
    }

    const db = (
      manager as {
        db?: import("node:sqlite").DatabaseSync;
      }
    ).db;
    if (!db) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "memory DB unavailable"));
      return;
    }

    const result = queryMessages({
      db,
      sessionKey:
        typeof params.filterSessionKey === "string" ? params.filterSessionKey.trim() : undefined,
      channel: typeof params.channel === "string" ? params.channel.trim() : undefined,
      senderId: typeof params.senderId === "string" ? params.senderId.trim() : undefined,
      direction: typeof params.direction === "string" ? params.direction.trim() : undefined,
      search: typeof params.search === "string" ? params.search.trim() : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
      offset: typeof params.offset === "number" ? params.offset : undefined,
      before: typeof params.before === "string" ? params.before.trim() : undefined,
      after: typeof params.after === "string" ? params.after.trim() : undefined,
    });

    respond(true, result);
  },

  "messages.stats": async ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "main";
    const { cfg } = loadSessionEntry(sessionKey);
    if (!cfg) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "config not found"));
      return;
    }

    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "memory manager unavailable"),
      );
      return;
    }

    const db = (
      manager as {
        db?: {
          prepare: (sql: string) => {
            all: (...args: unknown[]) => unknown[];
          };
        };
      }
    ).db;
    if (!db) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "memory DB unavailable"));
      return;
    }

    const days = typeof params.days === "number" ? params.days : 30;
    const filterChannel = typeof params.channel === "string" ? params.channel.trim() : undefined;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const channelCondition = filterChannel ? " AND channel = ?" : "";
    const channelArgs = filterChannel ? [filterChannel] : [];

    const totalRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM message_log WHERE created_at >= ?${channelCondition}`)
      .all(since, ...channelArgs) as Array<{ cnt: number }>;

    const byChannel = db
      .prepare(
        `SELECT channel, COUNT(*) as cnt FROM message_log
         WHERE created_at >= ?${channelCondition}
         GROUP BY channel ORDER BY cnt DESC`,
      )
      .all(since, ...channelArgs) as Array<{ channel: string | null; cnt: number }>;

    const byDirection = db
      .prepare(
        `SELECT direction, COUNT(*) as cnt FROM message_log
         WHERE created_at >= ?${channelCondition}
         GROUP BY direction`,
      )
      .all(since, ...channelArgs) as Array<{ direction: string; cnt: number }>;

    const bySender = db
      .prepare(
        `SELECT sender_id, sender_name, COUNT(*) as cnt FROM message_log
         WHERE created_at >= ? AND sender_id IS NOT NULL${channelCondition}
         GROUP BY sender_id ORDER BY cnt DESC LIMIT 20`,
      )
      .all(since, ...channelArgs) as Array<{
      sender_id: string;
      sender_name: string | null;
      cnt: number;
    }>;

    respond(true, {
      days,
      totalMessages: totalRow[0]?.cnt ?? 0,
      byChannel: Object.fromEntries(byChannel.map((r) => [r.channel ?? "unknown", r.cnt])),
      byDirection: Object.fromEntries(byDirection.map((r) => [r.direction, r.cnt])),
      bySender: bySender.map((r) => ({
        senderId: r.sender_id,
        senderName: r.sender_name,
        count: r.cnt,
      })),
    });
  },
};
