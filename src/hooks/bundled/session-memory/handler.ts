/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered.
 *
 * When `synthesis` is enabled (opt-in), session content is distilled through
 * an LLM pass before writing — producing a concise summary of decisions,
 * outcomes, and context worth remembering. When disabled (default), the raw
 * conversation messages are saved verbatim (legacy behavior).
 *
 * Output is always appended to the canonical daily file `memory/YYYY-MM-DD.md`
 * to align with the boot sequence (which reads that file on startup). A separate
 * slug-named file is also written for per-session granularity.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { appendFileWithinRoot, writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { synthesizeSessionContent } from "../../session-synthesizer.js";
import { findPreviousSessionFile, getRecentSessionContentWithResetFallback } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");

function resolveSessionTimestamp(
  timestamp: Date | number,
  cfg?: OpenClawConfig,
): { dateStr: string; timeStr: string; timeSlug: string; timezone: string } {
  const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone ?? process.env.TZ);
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year") ?? String(date.getUTCFullYear()).padStart(4, "0");
  const month = value("month") ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = value("day") ?? String(date.getUTCDate()).padStart(2, "0");
  const hour = value("hour") ?? String(date.getUTCHours()).padStart(2, "0");
  const minute = value("minute") ?? String(date.getUTCMinutes()).padStart(2, "0");
  const second = value("second") ?? String(date.getUTCSeconds()).padStart(2, "0");

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hour}:${minute}:${second}`,
    timeSlug: `${hour}${minute}`,
    timezone,
  };
}

function resolveDisplaySessionKey(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  sessionKey: string;
}): string {
  if (!params.cfg || !params.workspaceDir) {
    return params.sessionKey;
  }
  const workspaceAgentId = resolveAgentIdByWorkspacePath(params.cfg, params.workspaceDir);
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!workspaceAgentId || !parsed || workspaceAgentId === parsed.agentId) {
    return params.sessionKey;
  }
  return toAgentStoreSessionKey({
    agentId: workspaceAgentId,
    requestKey: parsed.rest,
  });
}

/**
 * Save session context to memory when /new or /reset command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on reset/new commands
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir =
      contextWorkspaceDir ||
      (cfg
        ? resolveAgentWorkspaceDir(cfg, agentId)
        : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
    const displaySessionKey = resolveDisplaySessionKey({
      cfg,
      workspaceDir: contextWorkspaceDir,
      sessionKey: event.sessionKey,
    });
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const { dateStr, timeStr, timeSlug, timezone } = resolveSessionTimestamp(event.timestamp, cfg);

    // Generate descriptive slug from session using LLM
    // Prefer previousSessionEntry (old session before /new) over current (which may be empty)
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

    // If sessionFile is empty or looks like a new/reset file, try to find the previous session file.
    if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
      const sessionsDirs = new Set<string>();
      if (currentSessionFile) {
        sessionsDirs.add(path.dirname(currentSessionFile));
      }
      sessionsDirs.add(path.join(workspaceDir, "sessions"));

      for (const sessionsDir of sessionsDirs) {
        const recoveredSessionFile = await findPreviousSessionFile({
          sessionsDir,
          currentSessionFile,
          sessionId: currentSessionId,
        });
        if (!recoveredSessionFile) {
          continue;
        }
        currentSessionFile = recoveredSessionFile;
        log.debug("Found previous session file", { file: currentSessionFile });
        break;
      }
    }

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
      hasCfg: Boolean(cfg),
    });

    const sessionFile = currentSessionFile || undefined;

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (sessionFile) {
      // Get recent conversation content, with fallback to rotated reset transcript.
      sessionContent = await getRecentSessionContentWithResetFallback(sessionFile, messageCount);
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });

      // Avoid calling the model provider in unit tests; keep hooks fast and deterministic.
      const isTestEnv =
        process.env.OPENCLAW_TEST_FAST === "1" ||
        process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.NODE_ENV === "test";
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug !== false;

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      slug = timeSlug;
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Create filename with date and slug
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(memoryDir, filename);
    log.debug("Memory file path resolved", {
      filename,
      path: memoryFilePath.replace(os.homedir(), "~"),
    });

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // When synthesis is enabled, run the session content through an LLM to distill
    // it into a concise summary. Falls back to raw content on failure.
    const synthesisEnabled = hookConfig?.synthesis === true;
    let outputContent = sessionContent;
    let synthesisSucceeded = false;

    if (synthesisEnabled && sessionContent && cfg) {
      log.debug("Running LLM synthesis on session content");
      const synthesized = await synthesizeSessionContent({
        sessionContent,
        cfg,
        sessionKey: displaySessionKey,
      });
      if (synthesized) {
        outputContent = synthesized;
        synthesisSucceeded = true;
        log.debug("Synthesis complete", { length: synthesized.length });
      } else {
        log.debug("Synthesis returned empty or failed, using raw content");
      }
    }

    // Build Markdown entry — date and time use the same timezone
    const timezoneLabel = timezone === "UTC" ? "UTC" : timezone;
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} (${timezoneLabel})`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];

    // Include conversation content if available
    if (outputContent) {
      if (synthesisEnabled && synthesisSucceeded) {
        entryParts.push("## Summary", "", outputContent, "");
      } else {
        entryParts.push("## Conversation Summary", "", outputContent, "");
      }
    }

    const entry = entryParts.join("\n");

    // Write slug-named file for per-session granularity.
    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });
    log.debug("Memory file written successfully");

    // Also append to canonical daily file (memory/YYYY-MM-DD.md) so the boot
    // sequence can find session memories without relying on memory_search.
    // Uses atomic appendFileWithinRoot to avoid TOCTOU races when multiple
    // /new commands fire in rapid succession on the same day.
    const canonicalFilename = `${dateStr}.md`;
    try {
      await appendFileWithinRoot({
        rootDir: memoryDir,
        relativePath: canonicalFilename,
        data: `\n---\n\n${entry}`,
        encoding: "utf-8",
        prependNewlineIfNeeded: false,
      });
      log.debug("Appended to canonical daily file", { canonicalFilename });
    } catch (err) {
      // Non-fatal — the slug file was already written.
      log.warn(`Failed to append to canonical daily file: ${String(err)}`);
    }

    // Log completion (but don't send user-visible confirmation - it's internal housekeeping)
    const relPath = memoryFilePath.replace(os.homedir(), "~");
    log.info(`Session context saved to ${relPath}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
};

export default saveSessionToMemory;
