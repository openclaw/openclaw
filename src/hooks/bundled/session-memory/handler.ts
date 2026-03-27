/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered.
 * Also saves memory when a subagent session ends (subagent_ended event).
 * Creates a new dated memory file with LLM-generated slug.
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
 * Derive workspace directory for a subagent from its session key.
 * Falls back to context.workspaceDir if available.
 */
function deriveSubagentWorkspace(
  targetSessionKey: string,
  context: Record<string, unknown>,
): string | undefined {
  if (context.workspaceDir) {
    return context.workspaceDir as string;
  }
  return undefined;
}

/**
 * Save session context to memory when /new or /reset command is triggered.
 * Also saves memory when a subagent session ends (subagent_ended event).
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Check event type
  const isResetCommand = event.action === "new" || event.action === "reset";
  const isSubagentEnded = event.type === "subagent_ended";

  if (event.type !== "command" && !isSubagentEnded) {
    return;
  }
  if (event.type === "command" && !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered", { type: event.type, action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const contextWorkspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
        ? context.workspaceDir
        : undefined;

    // For subagent_ended events, resolve workspace and session file differently
    let workspaceDir: string;
    let displaySessionKey: string;
    let sessionFile: string | undefined;
    let currentSessionId: string;

    if (isSubagentEnded) {
      // subagent_ended: use targetSessionKey and resolve workspace from session key pattern
      const targetSessionKey = (event as { targetSessionKey?: string }).targetSessionKey || event.sessionKey;
      log.debug("Processing subagent_ended event", { targetSessionKey });

      // Find session transcript file from main sessions directory
      const sessionsDir = path.join(resolveStateDir(process.env, os.homedir()), "agents/main/sessions");
      const sessionIdMatch = targetSessionKey.match(/^agent:main:subagent:(.+)$/);
      currentSessionId = sessionIdMatch ? sessionIdMatch[1] : targetSessionKey;

      // Try to find session file
      const sessionFilePath = path.join(sessionsDir, `${currentSessionId}.jsonl`);
      try {
        await fs.access(sessionFilePath);
        sessionFile = sessionFilePath;
      } catch {
        // Try topic variant
        const files = await fs.readdir(sessionsDir).catch(() => []);
        const match = files.find((f) => f.startsWith(currentSessionId) && f.endsWith(".jsonl"));
        if (match) {
          sessionFile = path.join(sessionsDir, match);
        }
      }

      // Derive workspace from subagent context or key pattern
      const subagentWorkspaceDir =
        (context.workspaceDir as string) || deriveSubagentWorkspace(targetSessionKey, context);
      workspaceDir =
        subagentWorkspaceDir ||
        path.join(resolveStateDir(process.env, os.homedir()), "workspace");
      displaySessionKey = targetSessionKey;
    } else {
      // command event (new/reset)
      const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
      workspaceDir =
        contextWorkspaceDir ||
        (cfg
          ? resolveAgentWorkspaceDir(cfg, agentId)
          : path.join(resolveStateDir(process.env, os.homedir()), "workspace"));
      displaySessionKey = resolveDisplaySessionKey({
        cfg,
        workspaceDir: contextWorkspaceDir,
        sessionKey: event.sessionKey,
      });

      const sessionEntry = (context.previousSessionEntry ||
        context.sessionEntry ||
        {}) as Record<string, unknown>;
      currentSessionId = sessionEntry.sessionId as string;
      sessionFile = undefined;
    }

    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Get today's date for filename - use local date, not UTC
    const now = new Date(event.timestamp);
    const dateStr = now.toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone

    // For command events, find session file from session entry
    if (!isSubagentEnded) {
      const sessionEntry = (context.previousSessionEntry ||
        context.sessionEntry ||
        {}) as Record<string, unknown>;
      let currentSessionFile = (sessionEntry.sessionFile as string) || undefined;

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
        sessionFile = currentSessionFile || undefined;
      } else {
        sessionFile = currentSessionFile;
      }
    }

    log.debug("Session context resolved", {
      sessionId: currentSessionId,
      sessionFile,
      hasCfg: Boolean(cfg),
    });

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

      // Only generate LLM slug when cfg is available (main agent)
      // subagent sessions don't have cfg context, so skip LLM slug for them
      const isTestEnv =
        process.env.OPENCLAW_TEST_FAST === "1" ||
        process.env.VITEST === "true" ||
        process.env.VITEST === "1" ||
        process.env.NODE_ENV === "test";
      const allowLlmSlug = !isTestEnv && hookConfig?.llmSlug !== false && cfg;

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
      slug = timeSlug.slice(0, 4); // HHMM
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
    const sessionId = currentSessionId || "unknown";
    const source = isSubagentEnded ? "subagent_ended" : ((context.commandSource as string) || "unknown");

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("## Conversation Summary", "", sessionContent, "");
    }

    const entry = entryParts.join("\n");

    // Write under memory root with alias-safe file validation.
    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });
    log.debug("Memory file written successfully");

    // Log completion
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
