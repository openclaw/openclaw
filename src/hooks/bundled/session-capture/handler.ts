/**
 * Session capture hook
 *
 * Synthesizes experiential session data when /new command is triggered.
 * Reads the previous session transcript and creates a summary in the
 * experiential store.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionSummary } from "../../../experiential/types.js";
import type { HookHandler } from "../../hooks.js";
import { ExperientialStore } from "../../../experiential/store.js";
import { resolveHookConfig } from "../../config.js";

const HOOK_KEY = "session-capture";

/**
 * Read recent messages from a session JSONL file.
 * Follows the same parsing pattern as session-memory/handler.ts.
 */
async function getSessionMessages(
  sessionFilePath: string,
  maxMessages = 30,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const messages: Array<{ role: string; content: string }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
            const text = Array.isArray(msg.content)
              ? // oxlint-disable-next-line typescript/no-explicit-any
                msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              messages.push({ role: msg.role, content: text });
            }
          }
        }
      } catch {
        // skip invalid JSON lines
      }
    }

    return messages.slice(-maxMessages);
  } catch {
    return [];
  }
}

/**
 * Extract topic phrases from session messages.
 * Simple heuristic: takes unique noun phrases from user messages.
 */
function extractTopicsFromMessages(messages: Array<{ role: string; content: string }>): string[] {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return [];
  }

  // Use first and last user messages as topic indicators
  const topics: string[] = [];
  const first = userMessages[0].content.slice(0, 100);
  const last = userMessages[userMessages.length - 1].content.slice(0, 100);

  if (first) {
    topics.push(first);
  }
  if (last && last !== first) {
    topics.push(last);
  }

  // Limit to reasonable count
  return topics.slice(0, 5);
}

const sessionCaptureHook: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const hookConfig = resolveHookConfig(cfg, HOOK_KEY);

    // Enabled by default; skip only if explicitly disabled
    if (hookConfig?.enabled === false) {
      return;
    }

    const sessionEntry = (context.previousSessionEntry || {}) as Record<string, unknown>;
    const sessionFile = sessionEntry.sessionFile as string | undefined;

    if (!sessionFile) {
      console.log("[session-capture] No previous session file, skipping");
      return;
    }

    const messages = await getSessionMessages(sessionFile);
    if (messages.length === 0) {
      console.log("[session-capture] No messages in previous session, skipping");
      return;
    }

    const now = event.timestamp.getTime();
    const topics = extractTopicsFromMessages(messages);

    // Collect buffered moments from the store for this session
    const store = new ExperientialStore();
    try {
      const bufferedMoments = store.getBufferedMoments(event.sessionKey);

      const summary: SessionSummary = {
        id: crypto.randomUUID(),
        version: 1,
        sessionKey: event.sessionKey,
        startedAt: now - 3600000, // approximate; real start not available here
        endedAt: now,
        topics,
        momentCount: bufferedMoments.length,
        keyAnchors: bufferedMoments.flatMap((m) => m.anchors).slice(0, 5),
        openUncertainties: bufferedMoments.flatMap((m) => m.uncertainties).slice(0, 5),
        reconstitutionHints: topics.length > 0 ? [`Session focused on: ${topics.join(", ")}`] : [],
      };

      store.saveSessionSummary(summary);

      // Archive consumed moments so they aren't re-counted on the next /new
      if (bufferedMoments.length > 0) {
        store.archiveBufferedMoments(event.sessionKey);
      }

      console.log(
        `[session-capture] Session summary saved: ${summary.id} (${messages.length} messages, ${bufferedMoments.length} moments)`,
      );
    } finally {
      store.close();
    }
  } catch (err) {
    console.error(
      "[session-capture] Failed to save session summary:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default sessionCaptureHook;
