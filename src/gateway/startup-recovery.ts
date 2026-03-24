/**
 * Channel-agnostic startup recovery.
 *
 * On gateway startup, scans all sessions for unanswered user messages
 * (where the user spoke last and the agent never responded, typically
 * because the gateway restarted mid-reply). For each unanswered
 * session, re-injects the message through the normal auto-reply
 * pipeline with a recovery preamble so the agent can decide whether
 * it still needs a response.
 */

import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { isRoutableChannel } from "../auto-reply/reply/route-reply.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveSessionTranscriptPath } from "../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
  resolveSessionResetType,
} from "../config/sessions/reset.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../routing/session-key.js";

const DEFAULT_RECOVERY_WINDOW_MS = 10 * 60_000;

type StartupRecoveryParams = {
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

/**
 * Returns true when the session has an unanswered user message:
 * lastUserMessageAt is set and is more recent than lastAgentResponseAt.
 *
 * Also checks the session transcript (JSONL file) as a fallback,
 * because lastAgentResponseAt may not have been persisted if the
 * gateway restarted mid-turn (e.g. agent triggered a restart via tool).
 */
function isUnanswered(entry: SessionEntry, agentId?: string): boolean {
  const userAt = entry.lastUserMessageAt;
  if (typeof userAt !== "number" || !Number.isFinite(userAt)) {
    return false;
  }
  const agentAt = entry.lastAgentResponseAt ?? 0;
  if (userAt <= agentAt) {
    return false;
  }

  // Session store says unanswered, but check the transcript as a
  // fallback. If the last message in the transcript is from the
  // assistant, the response was delivered but the store wasn't updated
  // (common when a restart is triggered mid-turn).
  if (transcriptShowsAssistantLast(entry, agentId)) {
    logVerbose(
      "startup-recovery: session store says unanswered but transcript " +
        "shows assistant responded last; skipping recovery",
    );
    return false;
  }

  return true;
}

/**
 * Check the session's JSONL transcript to see if the last message
 * entry is a successfully completed assistant response. Reads only
 * the tail of the file for efficiency.
 *
 * Returns false (allowing recovery) when the assistant's last turn
 * ended with an error (e.g. stopReason="error", CLI exit code 143
 * from SIGTERM), because the run was interrupted mid-task and the
 * response was never fully delivered.
 */
function transcriptShowsAssistantLast(entry: SessionEntry, agentId?: string): boolean {
  const sessionFile =
    entry.sessionFile?.trim() ||
    (entry.sessionId ? resolveSessionTranscriptPath(entry.sessionId, agentId) : null);
  if (!sessionFile) {
    return false;
  }

  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return false;
  }

  // Walk backwards through lines to find the last message entry.
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; stopReason?: string };
      };
      if (parsed.type === "message" && parsed.message?.role) {
        if (parsed.message.role !== "assistant") {
          return false;
        }
        // If the assistant turn ended with an error (e.g. process
        // killed by SIGTERM during a restart), the run was
        // interrupted and the response is incomplete. Allow
        // recovery so the agent can pick up where it left off.
        if (parsed.message.stopReason === "error") {
          logVerbose(
            "startup-recovery: last assistant message has " +
              'stopReason="error"; treating as interrupted run',
          );
          return false;
        }
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Build the recovery preamble that wraps the user's original message.
 * The agent sees this and decides whether a response is still needed.
 */
function buildRecoveryPrompt(userText: string): string {
  return (
    "[System: You were interrupted by a restart before you could " +
    "respond. The user's last message is below. Decide if this still " +
    'needs a response — if it was a casual sign-off like "thanks" ' +
    'or "nvm", a brief acknowledgement is fine.]\n\n' +
    userText
  );
}

export async function runStartupRecovery(params: StartupRecoveryParams): Promise<void> {
  const { cfg, log } = params;
  const sessionCfg = cfg.session;

  // Resolve the default agent store; multi-agent stores are under
  // different agent IDs, so load the default one. If the user has
  // configured multiple agents, we iterate per-agent below.
  const agentIds = resolveAgentIds(cfg);
  let totalRecovered = 0;

  for (const agentId of agentIds) {
    const storePath = resolveStorePath(sessionCfg?.store, { agentId });
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath, { skipCache: true });
    } catch (err) {
      log.warn(
        `startup-recovery: failed to load session store for agent "${agentId}": ${formatErrorMessage(err)}`,
      );
      continue;
    }

    const now = Date.now();
    const candidates: Array<{ sessionKey: string; entry: SessionEntry }> = [];

    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry || !isUnanswered(entry, agentId)) {
        continue;
      }

      // Ensure the session is still fresh (within its idle/daily
      // timeout). Stale sessions would start a new conversation
      // anyway, so skip them.
      const resetType = resolveSessionResetType({ sessionKey });
      const policy = resolveSessionResetPolicy({ sessionCfg, resetType });
      const freshness = evaluateSessionFreshness({
        updatedAt: entry.updatedAt,
        now,
        policy,
      });
      if (!freshness.fresh) {
        continue;
      }

      // Enforce a hard recovery window to avoid replaying very old
      // messages (e.g. if session idle timeout is extremely long).
      const userAt = entry.lastUserMessageAt!;
      if (now - userAt > DEFAULT_RECOVERY_WINDOW_MS) {
        continue;
      }

      // Need a delivery route to send the reply back.
      const channel = entry.deliveryContext?.channel ?? entry.lastChannel;
      const to = entry.deliveryContext?.to ?? entry.lastTo;
      if (!channel || !to) {
        continue;
      }
      if (!isRoutableChannel(channel)) {
        continue;
      }

      // Need the original message text to build the recovery prompt.
      if (!entry.lastUserMessageText?.trim()) {
        continue;
      }

      candidates.push({ sessionKey, entry });
    }

    if (candidates.length === 0) {
      continue;
    }

    logVerbose(
      `startup-recovery: found ${candidates.length} unanswered session(s) for agent "${agentId}"`,
    );

    for (const { sessionKey, entry } of candidates) {
      const channel = (entry.deliveryContext?.channel ?? entry.lastChannel)!;
      const to = (entry.deliveryContext?.to ?? entry.lastTo)!;
      const accountId = entry.deliveryContext?.accountId ?? entry.lastAccountId;
      const threadId = entry.deliveryContext?.threadId ?? entry.lastThreadId;
      const userText = entry.lastUserMessageText!.trim();
      const recoveryBody = buildRecoveryPrompt(userText);

      // Re-check the session right before dispatching to avoid TOCTOU races.
      // The initial isUnanswered check may have been stale if an agent run
      // completed between loading the store and reaching this point.
      try {
        const freshStore = loadSessionStore(storePath, { skipCache: true });
        const freshEntry = freshStore?.[sessionKey];
        if (freshEntry && !isUnanswered(freshEntry, agentId)) {
          logVerbose(
            `startup-recovery: session "${sessionKey}" was answered between check and dispatch; skipping`,
          );
          continue;
        }
      } catch {
        // If we can't re-read the store, proceed with caution (original check still valid).
      }

      try {
        await dispatchInboundMessageWithDispatcher({
          ctx: {
            Body: recoveryBody,
            RawBody: recoveryBody,
            CommandBody: recoveryBody,
            BodyForCommands: recoveryBody,
            SessionKey: sessionKey,
            // Use "recovery" as surface so the auto-reply pipeline
            // detects OriginatingChannel !== Surface and routes the
            // reply through routeReply instead of the dispatcher.
            Provider: "recovery",
            Surface: "recovery",
            OriginatingChannel: channel,
            OriginatingTo: to,
            AccountId: accountId,
            MessageThreadId: threadId,
            From: entry.origin?.from,
            To: to,
            ChatType: entry.chatType ?? "direct",
            CommandAuthorized: true,
          },
          cfg,
          dispatcherOptions: {
            deliver: async () => {
              // Replies route through routeReply (originating channel),
              // so this dispatcher callback is a no-op fallback.
            },
          },
        });
        totalRecovered++;
        logVerbose(`startup-recovery: re-triggered session "${sessionKey}" via ${String(channel)}`);
      } catch (err) {
        log.warn(
          `startup-recovery: failed to recover session "${sessionKey}": ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  if (totalRecovered > 0) {
    log.info(
      `startup-recovery: recovered ${totalRecovered} unanswered session${totalRecovered > 1 ? "s" : ""}`,
    );
  } else {
    logVerbose("startup-recovery: no unanswered sessions found");
  }
}

/**
 * Resolve the list of agent IDs to scan. Includes the default agent
 * plus any explicitly configured agents.
 */
function resolveAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  ids.add(normalizeAgentId(DEFAULT_AGENT_ID));
  const agentsCfg = cfg.agents;
  if (agentsCfg && typeof agentsCfg === "object") {
    // Check for multi-agent keys (agents.{agentId}.*)
    for (const key of Object.keys(agentsCfg)) {
      if (key === "defaults" || key === "scope") {
        continue;
      }
      const normalized = normalizeAgentId(key);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  return Array.from(ids);
}
