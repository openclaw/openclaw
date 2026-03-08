/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

const log = createSubsystemLogger("hooks/session-memory");

/**
 * Parse a memory recall window string like "7d" or "24h" into milliseconds
 */
function parseRecallWindow(window: string | undefined): number | null {
  if (!window) {
    return null;
  }
  const match = window.match(/^(\d+)([dh])$/);
  if (!match) {
    log.warn("Invalid recall window format", { window });
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "d") {
    return value * 24 * 60 * 60 * 1000;
  }
  if (unit === "h") {
    return value * 60 * 60 * 1000;
  }
  return null;
}

/**
 * Read recent memory files from the workspace memory directory
 */
async function getRecentMemoryFiles(params: {
  memoryDir: string;
  maxMemories: number;
  windowMs: number | null;
}): Promise<{ filename: string; content: string; date: Date }[]> {
  const { memoryDir, maxMemories, windowMs } = params;

  try {
    const files = await fs.readdir(memoryDir);
    const memoryFiles = files
      .filter((f) => f.endsWith(".md"))
      .toSorted()
      .toReversed(); // Newest first

    const now = new Date();
    const results: { filename: string; content: string; date: Date }[] = [];

    for (const filename of memoryFiles) {
      if (results.length >= maxMemories) {
        break;
      }

      // Parse date from filename: YYYY-MM-DD-slug.md
      const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-/);
      if (!dateMatch) {
        continue;
      }

      const fileDate = new Date(dateMatch[1]);
      if (isNaN(fileDate.getTime())) {
        continue;
      }

      // Apply time window filter
      if (windowMs !== null) {
        const ageMs = now.getTime() - fileDate.getTime();
        if (ageMs > windowMs) {
          continue;
        }
      }

      const content = await fs.readFile(path.join(memoryDir, filename), "utf-8");
      results.push({ filename, content, date: fileDate });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Truncate content to a maximum number of tokens (approximate)
 */
function truncateToTokens(content: string, maxTokens: number): string {
  // Rough approximation: 1 token ≈ 4 characters
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars).trim() + "\n\n[truncated]";
}

/**
 * Read recent messages from session file for slug generation
 */
async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // Parse JSONL and extract user/assistant messages first
    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            if (role === "user" && hasInterSessionUserProvenance(msg)) {
              continue;
            }
            // Extract text content
            const text = Array.isArray(msg.content)
              ? // oxlint-disable-next-line typescript/no-explicit-any
                msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    // Then slice to get exactly messageCount messages
    const recentMessages = allMessages.slice(-messageCount);
    return recentMessages.join("\n");
  } catch {
    return null;
  }
}

/**
 * Try the active transcript first; if /new already rotated it,
 * fallback to the latest .jsonl.reset.* sibling.
 */
async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    const fallback = await getRecentSessionContent(latestResetPath, messageCount);

    if (fallback) {
      log.debug("Loaded session content from reset fallback", {
        sessionFilePath,
        latestResetPath,
      });
    }

    return fallback || primary;
  } catch {
    return primary;
  }
}

function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const baseFromReset = params.currentSessionFile
      ? stripResetSuffix(path.basename(params.currentSessionFile))
      : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}

/**
 * Recall session context from memory when agent starts (agent:bootstrap event)
 */
async function recallSessionMemory(event: Parameters<HookHandler>[0]): Promise<void> {
  // Only trigger on agent bootstrap - check type and action directly
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }

  const context = event.context;
  const cfg = context.cfg as OpenClawConfig | undefined;
  const workspaceDir = context.workspaceDir;

  if (!workspaceDir) {
    return;
  }

  try {
    const hookConfig = resolveHookConfig(cfg, "session-memory");

    // Check if recall is enabled
    const recallMode = (hookConfig?.memoryRecallMode as string) || "relevant";
    if (recallMode === "off") {
      return;
    }

    // Get configuration options with defaults
    const maxMemories =
      typeof hookConfig?.maxMemoriesToRecall === "number" && hookConfig.maxMemoriesToRecall > 0
        ? hookConfig.maxMemoriesToRecall
        : 3;
    const maxTokens =
      typeof hookConfig?.memoryRecallTokens === "number" && hookConfig.memoryRecallTokens > 0
        ? hookConfig.memoryRecallTokens
        : 500;
    const windowStr = hookConfig?.memoryRecallWindow as string | undefined;
    const windowMs = parseRecallWindow(windowStr);

    const memoryDir = path.join(workspaceDir, "memory");

    // Get recent memory files
    const memories = await getRecentMemoryFiles({
      memoryDir,
      maxMemories,
      windowMs,
    });

    if (memories.length === 0) {
      log.debug("No memory files found to recall");
      return;
    }

    log.debug("Recalling memory files", { count: memories.length });

    // Build the recall content
    const memoryBlocks = memories.map((mem) => {
      const truncated = truncateToTokens(mem.content, maxTokens);
      return `## Previous Session: ${mem.filename.replace(".md", "")}\n\n${truncated}`;
    });

    const recallContent = `[Previous Context]\n\n${memoryBlocks.join("\n\n---\n\n")}\n\n---\n\nThese are summaries of previous sessions. Use this context to maintain continuity if relevant to the current conversation.`;

    // Set the recall content in the context for prependContext
    context.prependContext = recallContent;
    log.debug("Memory recall content prepared", {
      memoriesCount: memories.length,
      contentLength: recallContent.length,
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to recall session memory", {
        errorName: err.name,
        errorMessage: err.message,
      });
    } else {
      log.error("Failed to recall session memory", { error: String(err) });
    }
  }
}

/**
 * Save session context to memory when /new or /reset command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Handle recall on agent:bootstrap events
  if (event.type === "agent" && event.action === "bootstrap") {
    await recallSessionMemory(event);
    return;
  }

  // Only trigger on reset/new commands for saving
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

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
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${event.sessionKey}`,
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
