/**
 * Context digest hook handler.
 *
 * Maintains a rolling cross-session digest at memory/context-digest.md.
 * Collects recent session transcripts, generates a structured LLM summary
 * (or a fallback), and writes it with a freshness header. Includes mutex
 * debounce and session:end dedup protection.
 *
 * Heavy work (transcript collection + LLM) runs fire-and-forget so the
 * hook dispatch returns immediately and does not block /new or /reset.
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
  generateDigestIncremental,
  generateDigestFallback,
  parseDigestHeader,
  isTestEnvironment,
  withDigestLock,
  shouldProcessSession,
  markSessionProcessed,
  MAX_DIGEST_PROMPT_CHARS,
} from "../../llm-memory-helpers.js";
import {
  collectRecentSessionTranscripts,
  collectNewSessionsSince,
} from "../../transcript-reader.js";

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

const EMPTY_DIGEST_BODY = [
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

/**
 * Core digest generation logic, extracted so it can run in the background.
 * Supports three modes:
 *   1. Skip — digest is still fresh (no sessions updated since last write)
 *   2. Incremental — 1-2 new sessions since last digest → merge prompt
 *   3. Full rebuild — first run, many new sessions, or incremental fails
 */
async function runDigest(params: {
  event: Parameters<HookHandler>[0];
  cfg: OpenClawConfig | undefined;
  agentId: string;
  workspaceDir: string;
  context: Record<string, unknown>;
}): Promise<void> {
  const { event, cfg, agentId, workspaceDir, context } = params;

  await withDigestLock(workspaceDir, async () => {
    log.debug("Context digest hook triggered", {
      type: event.type,
      action: event.action,
    });

    const hookConfig = resolveHookConfig(cfg, "context-digest");
    const days =
      typeof hookConfig?.days === "number" && hookConfig.days > 0 ? hookConfig.days : DEFAULT_DAYS;
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
    const memoryDir = path.join(workspaceDir, "memory");
    const digestFilePath = path.join(memoryDir, "context-digest.md");

    // --- Staleness check: read existing digest header ---
    let existingContent: string | null = null;
    let existingHeader: ReturnType<typeof parseDigestHeader> = null;
    try {
      existingContent = await fs.readFile(digestFilePath, "utf-8");
      existingHeader = parseDigestHeader(existingContent);
    } catch {
      // File doesn't exist yet — will do full rebuild
    }

    // If we have a valid header, check for new sessions since last digest
    let newSessionsSinceLastDigest: Map<
      string,
      import("../../transcript-reader.js").SessionTranscriptSummary
    > | null = null;
    if (existingHeader && existingHeader.lastUpdated > 0) {
      newSessionsSinceLastDigest = await collectNewSessionsSince({
        storePath,
        sinceTimestamp: existingHeader.lastUpdated,
        maxMessagesPerSession: maxSessionMessages,
        maxTotalChars: MAX_DIGEST_PROMPT_CHARS,
      });

      if (newSessionsSinceLastDigest.size === 0) {
        log.debug("Digest still fresh — no sessions updated since last write, skipping", {
          lastUpdated: new Date(existingHeader.lastUpdated).toISOString(),
        });
        return;
      }
    }

    // Determine mode: incremental merge vs full rebuild
    const allowLlm = llmDigest && !isTestEnvironment() && cfg !== undefined;
    const MAX_INCREMENTAL_SESSIONS = 2;
    const canIncremental =
      existingContent !== null &&
      existingHeader !== null &&
      newSessionsSinceLastDigest !== null &&
      newSessionsSinceLastDigest.size <= MAX_INCREMENTAL_SESSIONS &&
      newSessionsSinceLastDigest.size > 0;

    let digestBody: string;

    if (canIncremental && allowLlm) {
      // --- Incremental merge path ---
      log.debug("Using incremental digest merge", {
        newSessions: newSessionsSinceLastDigest!.size,
      });

      // Strip header from existing content to get just the body
      const bodyStart = existingContent!.indexOf("\n\n");
      const existingBody = bodyStart > 0 ? existingContent!.slice(bodyStart + 2) : existingContent!;

      const mergedBody = await generateDigestIncremental({
        existingDigest: existingBody,
        newTranscripts: newSessionsSinceLastDigest!,
        cfg: cfg,
      });

      if (mergedBody) {
        // Successful incremental merge — update session count
        const totalSessions = existingHeader!.sessionsCovered + newSessionsSinceLastDigest!.size;
        digestBody = mergedBody;

        if (digestBody.length > MAX_OUTPUT_CHARS) {
          digestBody =
            digestBody.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [content truncated for size]";
        }

        const header = [
          "# Context Digest (auto-generated)",
          `Last updated: ${now.toISOString()}`,
          `Sessions covered: ${totalSessions}`,
          `Window: ${days} days`,
          "",
        ].join("\n");

        await fs.mkdir(memoryDir, { recursive: true });
        await writeFileWithinRoot({
          rootDir: memoryDir,
          relativePath: "context-digest.md",
          data: header + digestBody,
          encoding: "utf-8",
        });

        const relPath = digestFilePath.replace(os.homedir(), "~");
        log.info(
          `Context digest incrementally updated: ${relPath} (+${newSessionsSinceLastDigest!.size} sessions, total ${totalSessions})`,
        );
        return;
      }
      // Incremental merge failed — fall through to full rebuild
      log.debug("Incremental merge returned null, falling back to full rebuild");
    }

    // --- Full rebuild path ---
    const transcripts = await collectRecentSessionTranscripts({
      storePath,
      days,
      now,
      maxMessagesPerSession: maxSessionMessages,
      maxTotalChars: MAX_DIGEST_PROMPT_CHARS,
    });

    if (transcripts.size === 0) {
      digestBody = EMPTY_DIGEST_BODY;
    } else {
      let llmResult: string | null = null;
      if (allowLlm) {
        llmResult = await generateDigestViaLLM({ transcripts, cfg: cfg });
      }
      digestBody = llmResult ?? generateDigestFallback(transcripts);
    }

    if (digestBody.length > MAX_OUTPUT_CHARS) {
      digestBody = digestBody.slice(0, MAX_OUTPUT_CHARS) + "\n\n... [content truncated for size]";
    }

    const header = [
      "# Context Digest (auto-generated)",
      `Last updated: ${now.toISOString()}`,
      `Sessions covered: ${transcripts.size}`,
      `Window: ${days} days`,
      "",
    ].join("\n");

    await fs.mkdir(memoryDir, { recursive: true });
    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: "context-digest.md",
      data: header + digestBody,
      encoding: "utf-8",
    });

    const relPath = digestFilePath.replace(os.homedir(), "~");
    log.info(`Context digest updated: ${relPath} (${transcripts.size} sessions, ${days}d)`);
  });
}

const contextDigestHandler: HookHandler = async (event) => {
  const isCommand =
    event.type === "command" && (event.action === "new" || event.action === "reset");
  const isSessionEnd = event.type === "session" && event.action === "end";

  if (!isCommand && !isSessionEnd) {
    return;
  }

  // Quick synchronous checks (dedup, resolve paths) — these are fast and
  // must complete before we decide whether to schedule background work.
  const context = event.context || {};
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
    string,
    unknown
  >;
  const sessionId = (sessionEntry.sessionId as string) || "";
  if (sessionId && !shouldProcessSession(sessionId, "context-digest")) {
    log.debug("Session already processed, skipping (dedup)", { sessionId });
    return;
  }
  if (sessionId) {
    markSessionProcessed(sessionId, "context-digest");
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

  // Fire-and-forget: heavy work (transcript read + LLM) runs in background.
  // In test environments we await so assertions can verify results.
  const work = runDigest({ event, cfg, agentId, workspaceDir, context });

  if (isTestEnvironment()) {
    await work;
  } else {
    void work.catch((err) => {
      if (err instanceof Error) {
        log.error("Context digest background task failed", {
          errorName: err.name,
          errorMessage: err.message,
          stack: err.stack,
        });
      } else {
        log.error("Context digest background task failed", { error: String(err) });
      }
    });
  }
};

export default contextDigestHandler;
