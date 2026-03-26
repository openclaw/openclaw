/**
 * /powernaphere - Reset only the current session.
 *
 * A lightweight, targeted powernap that resets just the session the command
 * was sent from. No drain, no gateway restart, no sentinel needed.
 *
 * - Preserves user preferences (model, thinking level, label, etc.)
 * - Fires before_reset hook for this session only
 * - Archives this session's transcript
 * - Rejects cron sessions
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import { snapshotSessionOrigin } from "../../config/sessions/metadata.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { archiveSessionTranscripts } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { CommandHandler } from "./commands-types.js";

const HOOK_TIMEOUT_MS = 5_000;

export const handlePowernapHereCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/powernaphere") {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /powernaphere from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const sessionKey = params.sessionKey;

  // Reject cron sessions
  if (sessionKey.includes(":cron:")) {
    return {
      shouldContinue: false,
      reply: { text: "Can't powernap a cron session." },
    };
  }

  const agentId = params.agentId || resolveAgentIdFromSessionKey(sessionKey);
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId });

  const currentEntry = params.sessionEntry;
  if (!currentEntry) {
    return {
      shouldContinue: false,
      reply: { text: "No active session to reset." },
    };
  }

  const oldSessionId = currentEntry.sessionId;
  const oldSessionFile = currentEntry.sessionFile;

  // Fire before_reset hook for this session (5s timeout per hook)
  await fireHookForSession({
    sessionKey,
    sessionId: oldSessionId,
    sessionFile: oldSessionFile,
    agentId,
    workspaceDir: params.workspaceDir,
  });

  // Reset just this session
  const now = Date.now();
  await updateSessionStore(storePath, (mutableStore) => {
    const entry = mutableStore[sessionKey];
    if (!entry) {
      return;
    }

    const nextEntry: SessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      // Preserve user-set preferences
      thinkingLevel: entry.thinkingLevel,
      verboseLevel: entry.verboseLevel,
      reasoningLevel: entry.reasoningLevel,
      responseUsage: entry.responseUsage,
      model: entry.model,
      contextTokens: entry.contextTokens,
      sendPolicy: entry.sendPolicy,
      label: entry.label,
      origin: snapshotSessionOrigin(entry),
      lastChannel: entry.lastChannel,
      lastTo: entry.lastTo,
      skillsSnapshot: entry.skillsSnapshot,
      // Reset token counts
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    mutableStore[sessionKey] = nextEntry;
  });

  // Archive old transcript (best-effort)
  try {
    archiveSessionTranscripts({
      sessionId: oldSessionId,
      storePath,
      sessionFile: oldSessionFile,
      agentId,
      reason: "reset",
    });
  } catch {
    // Archive failures are non-fatal
  }

  return {
    shouldContinue: false,
    reply: { text: "Session reset. This chat is fresh. Everything else untouched." },
  };
};

async function fireHookForSession(info: {
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  agentId: string;
  workspaceDir?: string;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  try {
    const messages: unknown[] = [];
    if (info.sessionFile) {
      try {
        const content = await fs.readFile(info.sessionFile, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "message" && parsed.message) {
              messages.push(parsed.message);
            }
          } catch {
            // skip malformed JSONL lines
          }
        }
      } catch {
        // Session file may not exist
      }
    }

    await Promise.race([
      hookRunner.runBeforeReset(
        { sessionFile: info.sessionFile, messages, reason: "powernap" },
        {
          agentId: info.agentId,
          sessionKey: info.sessionKey,
          sessionId: info.sessionId,
          workspaceDir: info.workspaceDir,
        },
      ),
      new Promise((resolve) => setTimeout(resolve, HOOK_TIMEOUT_MS)),
    ]);
  } catch (err: unknown) {
    logVerbose(`/powernaphere before_reset hook failed: ${String(err)}`);
  }
}
