/**
 * Context digest hook handler.
 *
 * Maintains a rolling cross-session digest at memory/context-digest.md.
 * Collects recent session transcripts, generates a structured LLM summary
 * (or a fallback), and writes it with a freshness header. Includes mutex
 * debounce and session:end dedup protection.
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
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import {
  generateDigestViaLLM,
  generateDigestFallback,
  isTestEnvironment,
  withDigestLock,
  shouldProcessSession,
  markSessionProcessed,
  MAX_DIGEST_PROMPT_CHARS,
} from "../../llm-memory-helpers.js";
import { collectRecentSessionTranscripts } from "../../transcript-reader.js";

const log = createSubsystemLogger("hooks/context-digest");

const DEFAULT_DAYS = 7;
const DEFAULT_MAX_SESSION_MESSAGES = 20;
const MAX_OUTPUT_CHARS = 8192;

function resolveStorePath(context: Record<string, unknown>, agentId: string): string | null {
  if (typeof context.storePath === "string") {
    return context.storePath;
  }
  const stateDir = resolveStateDir(process.env, () => os.homedir());
  return path.join(stateDir, "agents", agentId || "main", "sessions", "sessions.json");
}

const contextDigestHandler: HookHandler = async (event) => {
  const isCommand =
    event.type === "command" && (event.action === "new" || event.action === "reset");
  const isSessionEnd = event.type === "session" && event.action === "end";

  if (!isCommand && !isSessionEnd) {
    return;
  }

  try {
    // Session:end dedup filter
    const context = event.context || {};
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const sessionId = (sessionEntry.sessionId as string) || "";
    if (sessionId && !shouldProcessSession(sessionId)) {
      log.debug("Session already processed, skipping (dedup)", { sessionId });
      return;
    }
    if (sessionId) {
      markSessionProcessed(sessionId);
    }

    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    let workspaceDir: string;
    if (cfg) {
      workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    } else {
      log.warn("cfg not available in hook context; falling back to default workspace path");
      workspaceDir = path.join(
        resolveStateDir(process.env, () => os.homedir()),
        "workspace",
      );
    }

    // Mutex: debounce concurrent digest generation
    await withDigestLock(workspaceDir, async () => {
      log.debug("Context digest hook triggered", {
        type: event.type,
        action: event.action,
      });

      const hookConfig = resolveHookConfig(cfg, "context-digest");
      const days =
        typeof hookConfig?.days === "number" && hookConfig.days > 0
          ? hookConfig.days
          : DEFAULT_DAYS;
      const maxSessionMessages =
        typeof hookConfig?.maxSessionMessages === "number" && hookConfig.maxSessionMessages > 0
          ? hookConfig.maxSessionMessages
          : DEFAULT_MAX_SESSION_MESSAGES;
      const llmDigest = hookConfig?.llmDigest !== false;

      const storePath = resolveStorePath(context, agentId);
      if (!storePath) {
        log.debug("Could not resolve sessions store path");
        return;
      }

      const now = new Date(event.timestamp);

      const transcripts = await collectRecentSessionTranscripts({
        storePath,
        days,
        now,
        maxMessagesPerSession: maxSessionMessages,
        maxTotalChars: MAX_DIGEST_PROMPT_CHARS,
      });

      let digestBody: string;

      if (transcripts.size === 0) {
        digestBody = [
          "## Topics Discussed",
          "",
          "No conversations in the recent window.",
          "",
          "## Key Decisions",
          "",
          "*None*",
          "",
          "## Open Items / Action Items",
          "",
          "*None*",
          "",
          "## Important Context",
          "",
          "*None*",
          "",
        ].join("\n");
      } else {
        const allowLlm = llmDigest && !isTestEnvironment() && cfg !== undefined;

        let llmResult: string | null = null;
        if (allowLlm) {
          llmResult = await generateDigestViaLLM({ transcripts, cfg: cfg });
        }

        digestBody = llmResult ?? generateDigestFallback(transcripts);
      }

      // Enforce output cap
      if (digestBody.length > MAX_OUTPUT_CHARS) {
        digestBody = digestBody.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [content truncated for size]";
      }

      // Build full document with freshness header
      const header = [
        "# Context Digest (auto-generated)",
        `Last updated: ${now.toISOString()}`,
        `Sessions covered: ${transcripts.size}`,
        `Window: ${days} days`,
        "",
      ].join("\n");

      const fullDocument = header + digestBody;

      const memoryDir = path.join(workspaceDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      await writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: "context-digest.md",
        data: fullDocument,
        encoding: "utf-8",
      });

      const relPath = path.join(memoryDir, "context-digest.md").replace(os.homedir(), "~");
      log.info(`Context digest updated: ${relPath} (${transcripts.size} sessions, ${days}d)`);
    });
  } catch (err) {
    if (err instanceof Error) {
      log.error("Context digest hook failed", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Context digest hook failed", { error: String(err) });
    }
  }
};

export default contextDigestHandler;
