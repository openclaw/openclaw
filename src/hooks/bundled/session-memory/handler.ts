/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { findPreviousSessionFile, getRecentSessionContentWithResetFallback } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");

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

    // NOTE: blockSessionSave and sessionSaveContent are checked in a
    // postHookActions callback (see bottom of this handler) so that hooks
    // registered after this bundled handler can still set them.  The file
    // is written inline (fail-safe: if postHookActions never runs, data is
    // preserved on disk).  The post-hook callback handles retraction
    // (blockSessionSave) and content replacement (sessionSaveContent).

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

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

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
    const hasCustomContent = typeof context.sessionSaveContent === "string";

    if (sessionFile && !hasCustomContent) {
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
      const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
      slug = timeSlug.slice(0, 6); // HHMMSS — seconds prevent same-minute overwrites
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Create filename with date and slug
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(memoryDir, filename);
    log.debug("Memory file path resolved", {
      filename,
      path: memoryFilePath.replace(os.homedir(), "~"),
    });

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Use custom content from upstream hook if available, otherwise build entry.
    // hasCustomContent (set above) already gates session loading + slug generation.
    let entry: string;
    if (hasCustomContent) {
      // An empty string is a valid redaction signal — hooks may intentionally
      // set it to persist a blank marker while avoiding transcript retention.
      entry = context.sessionSaveContent as string;
      log.debug("Using custom session content from upstream hook", {
        length: entry.length,
      });
    } else {
      const entryParts = [
        `# Session: ${dateStr} ${timeStr} UTC`,
        "",
        `- **Session Key**: ${event.sessionKey}`,
        `- **Session ID**: ${sessionId}`,
        `- **Source**: ${source}`,
        "",
      ];

      if (sessionContent) {
        entryParts.push("## Conversation Summary", "", sessionContent, "");
      }

      entry = entryParts.join("\n");
    }

    // Write inline (fail-safe: if postHookActions never drains, the file
    // is preserved on disk with the best content available at this point).
    // If blockSessionSave was already set by an upstream hook, skip the write.
    if (context.blockSessionSave === true) {
      log.debug("Session save blocked by upstream hook (inline check)");
    } else {
      await fs.mkdir(memoryDir, { recursive: true });
      await writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: filename,
        data: entry,
        encoding: "utf-8",
      });
      log.debug("Memory file written successfully");

      const relPath = memoryFilePath.replace(os.homedir(), "~");
      log.info(`Session context saved to ${relPath}`);
    }

    // Defer retraction/replacement to post-hook phase so that hooks
    // registered after this handler can set blockSessionSave or
    // sessionSaveContent and still have them honored.
    const writtenEntry = context.blockSessionSave === true ? null : entry;
    event.postHookActions.push(async () => {
      try {
        // If a later hook blocked the save, retract the file we just wrote.
        if (event.context.blockSessionSave === true && writtenEntry !== null) {
          try {
            await fs.unlink(memoryFilePath);
            log.debug("Session save retracted by post-hook (blockSessionSave)");
          } catch (err) {
            // File may not exist if inline write also didn't happen — that's fine.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              throw err;
            }
          }
          return;
        }

        // If a later hook set sessionSaveContent, overwrite with new content.
        const postContent = event.context.sessionSaveContent;
        if (typeof postContent === "string" && postContent !== writtenEntry) {
          await writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: filename,
            data: postContent,
            encoding: "utf-8",
          });
          log.debug("Session save content replaced by post-hook (sessionSaveContent)", {
            length: postContent.length,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Post-hook session-memory action failed: ${message}`);
      }
    });
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
