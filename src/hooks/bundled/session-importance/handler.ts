/**
 * Session importance hook handler.
 *
 * Two-stage pipeline: multi-dimensional pre-filter (zero LLM cost for routine
 * conversations) followed by LLM classification for potential important
 * sessions. Persists classified conversations to memory/important/ with
 * slug-based deduplication and smart append.
 *
 * Heavy work (transcript read + LLM) runs fire-and-forget so the
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
  evaluateSessionImportance,
  classifyImportanceViaLLM,
  classifyImportanceFallback,
  isTestEnvironment,
  shouldProcessSession,
  markSessionProcessed,
  type ImportanceClassification,
} from "../../llm-memory-helpers.js";
import { parseTranscriptMessages } from "../../transcript-reader.js";

const log = createSubsystemLogger("hooks/session-importance");

const DEFAULT_MESSAGE_COUNT = 30;

/**
 * Extract the slug portion from an importance filename.
 * Format: YYYY-MM-DD-category-slug.md -> slug
 */
function extractSlugFromFilename(filename: string): string | null {
  const match = filename.match(
    /^\d{4}-\d{2}-\d{2}-(?:research|project|decision|reference)-(.+)\.md$/,
  );
  return match ? match[1] : null;
}

/**
 * Find an existing file in memory/important/ whose slug matches.
 */
async function findExistingSlugFile(importantDir: string, slug: string): Promise<string | null> {
  try {
    const files = await fs.readdir(importantDir);
    for (const file of files) {
      const existingSlug = extractSlugFromFilename(file);
      if (existingSlug === slug) {
        return path.join(importantDir, file);
      }
    }
  } catch {
    // directory may not exist yet
  }
  return null;
}

/**
 * Build the initial Markdown content for a new important memory file.
 */
function buildNewImportantFile(params: {
  classification: ImportanceClassification;
  dateStr: string;
  matchedKeywords: string[];
  sessionKey: string;
  sessionId: string;
}): string {
  const { classification, dateStr, matchedKeywords, sessionKey, sessionId } = params;
  const parts: string[] = [
    `# Important: ${classification.category} - ${classification.slug}`,
    `Date: ${dateStr}`,
    `Category: ${classification.category}`,
    `Tags: ${matchedKeywords.join(", ")}`,
    `Session Key: ${sessionKey}`,
    `Session ID: ${sessionId}`,
    "",
  ];

  if (classification.summary) {
    parts.push("## Summary", "", classification.summary, "");
  }

  if (classification.keyPoints.length > 0) {
    parts.push("## Key Points", "");
    for (const point of classification.keyPoints) {
      parts.push(`- ${point}`);
    }
    parts.push("");
  }

  if (classification.actionItems.length > 0) {
    parts.push("## Action Items", "");
    for (const item of classification.actionItems) {
      const prefix = item.startsWith("- ") ? "" : "- [ ] ";
      parts.push(`${prefix}${item}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Build the append section for an existing important memory file.
 */
function buildAppendSection(params: {
  classification: ImportanceClassification;
  dateStr: string;
}): string {
  const { classification, dateStr } = params;
  const parts: string[] = ["", "---", `## Update: ${dateStr}`, ""];

  if (classification.summary) {
    parts.push(`**Summary**: ${classification.summary}`, "");
  }

  if (classification.keyPoints.length > 0) {
    parts.push("**Key Points**:", "");
    for (const point of classification.keyPoints) {
      parts.push(`- ${point}`);
    }
    parts.push("");
  }

  if (classification.actionItems.length > 0) {
    parts.push("**Action Items**:", "");
    for (const item of classification.actionItems) {
      const prefix = item.startsWith("- ") ? "" : "- [ ] ";
      parts.push(`${prefix}${item}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

const MIN_USER_MESSAGES = 3;

/**
 * Check if a session was already classified by looking for its sessionId
 * in existing important/ files' metadata.
 */
async function isAlreadyClassified(importantDir: string, sessionId: string): Promise<boolean> {
  if (!sessionId) {
    return false;
  }
  try {
    const files = await fs.readdir(importantDir);
    for (const file of files) {
      if (!file.endsWith(".md")) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(importantDir, file), "utf-8");
        // Check the header metadata for Session ID match
        if (content.includes(`Session ID: ${sessionId}`)) {
          return true;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory doesn't exist yet — not classified
  }
  return false;
}

/**
 * Core importance classification + persist logic, extracted for background execution.
 */
async function runClassification(params: {
  event: Parameters<HookHandler>[0];
  cfg: OpenClawConfig | undefined;
  workspaceDir: string;
  sessionId: string;
  sessionFile: string;
}): Promise<void> {
  const { event, cfg, workspaceDir, sessionId, sessionFile } = params;

  // Already-classified guard: skip if this session was persisted in a prior run
  const importantDir = path.join(workspaceDir, "memory", "important");
  if (sessionId && (await isAlreadyClassified(importantDir, sessionId))) {
    log.debug("Session already classified in a prior run, skipping", { sessionId });
    return;
  }

  const hookConfig = resolveHookConfig(cfg, "session-importance");
  const messageCount =
    typeof hookConfig?.messages === "number" && hookConfig.messages > 0
      ? hookConfig.messages
      : DEFAULT_MESSAGE_COUNT;
  const llmClassify = hookConfig?.llmClassify !== false;

  const messages = await parseTranscriptMessages(sessionFile, {
    maxMessages: messageCount,
  });

  if (messages.length === 0) {
    log.debug("No messages in session, skipping");
    return;
  }

  // Short-session skip: trivial sessions with very few user messages
  const userMessageCount = messages.filter((m) => m.role === "user").length;
  if (userMessageCount < MIN_USER_MESSAGES) {
    log.debug("Session too short for importance analysis, skipping", {
      userMessages: userMessageCount,
      threshold: MIN_USER_MESSAGES,
    });
    return;
  }

  // Stage 1: Multi-dimensional importance evaluation
  const customKeywords = Array.isArray(hookConfig?.customKeywords)
    ? (hookConfig.customKeywords as string[]).filter((k) => typeof k === "string")
    : undefined;
  const evaluation = evaluateSessionImportance(messages, customKeywords);

  if (!evaluation.pass) {
    log.debug("Session evaluated as routine by multi-dimensional scorer, skipping", {
      score: evaluation.score,
      signals: evaluation.signals,
    });
    return;
  }

  const matchedKeywords = evaluation.matchedKeywords;

  log.debug("Importance evaluation passed", {
    score: evaluation.score,
    signals: evaluation.signals,
    hintCategory: evaluation.hintCategory,
  });

  // Stage 2: LLM classification (or fallback with evaluation context)
  let classification: ImportanceClassification | null = null;
  const allowLlm = llmClassify && !isTestEnvironment() && cfg !== undefined;

  if (allowLlm) {
    classification = await classifyImportanceViaLLM({ messages, cfg: cfg });
  }

  if (!classification) {
    classification = classifyImportanceFallback(messages, evaluation);
  }

  if (!classification || !classification.important || classification.category === "routine") {
    log.debug("Session classified as not important after analysis, skipping");
    return;
  }

  log.info(`Session classified as ${classification.category}: ${classification.slug}`);

  // Write to memory/important/
  const now = new Date(event.timestamp);
  const dateStr = now.toISOString().split("T")[0];
  await fs.mkdir(importantDir, { recursive: true });

  // Slug-based deduplication
  const existingFile = await findExistingSlugFile(importantDir, classification.slug);

  if (existingFile) {
    log.debug("Found existing file with matching slug, appending", {
      existingFile: existingFile.replace(os.homedir(), "~"),
    });

    const existingContent = await fs.readFile(existingFile, "utf-8");
    const appendSection = buildAppendSection({ classification, dateStr });
    const updatedContent = existingContent + appendSection;

    const existingFilename = path.basename(existingFile);
    await writeFileWithinRoot({
      rootDir: importantDir,
      relativePath: existingFilename,
      data: updatedContent,
      encoding: "utf-8",
    });

    const relPath = existingFile.replace(os.homedir(), "~");
    log.info(`Appended update to existing important file: ${relPath}`);
  } else {
    const filename = `${dateStr}-${classification.category}-${classification.slug}.md`;

    const content = buildNewImportantFile({
      classification,
      dateStr,
      matchedKeywords,
      sessionKey: event.sessionKey,
      sessionId: sessionId || "unknown",
    });

    await writeFileWithinRoot({
      rootDir: importantDir,
      relativePath: filename,
      data: content,
      encoding: "utf-8",
    });

    const relPath = path.join(importantDir, filename).replace(os.homedir(), "~");
    log.info(`Saved important conversation to ${relPath}`);
  }
}

const sessionImportanceHandler: HookHandler = async (event) => {
  const isCommand =
    event.type === "command" && (event.action === "new" || event.action === "reset");
  const isSessionEnd = event.type === "session" && event.action === "end";

  if (!isCommand && !isSessionEnd) {
    return;
  }

  // Quick synchronous checks — must complete before scheduling background work.
  const context = event.context || {};
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
    string,
    unknown
  >;
  const sessionId = (sessionEntry.sessionId as string) || "";
  if (sessionId && !shouldProcessSession(sessionId, "session-importance")) {
    log.debug("Session already processed, skipping (dedup)", { sessionId });
    return;
  }
  if (sessionId) {
    markSessionProcessed(sessionId, "session-importance");
  }

  log.debug("Session importance hook triggered", {
    type: event.type,
    action: event.action,
  });

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

  const sessionFile = (sessionEntry.sessionFile as string) || undefined;
  if (!sessionFile) {
    log.debug("No session file available, skipping");
    return;
  }

  // Fire-and-forget: heavy work runs in background.
  // In test environments we await so assertions can verify results.
  const work = runClassification({ event, cfg, workspaceDir, sessionId, sessionFile });

  if (isTestEnvironment()) {
    await work;
  } else {
    void work.catch((err) => {
      if (err instanceof Error) {
        log.error("Session importance background task failed", {
          errorName: err.name,
          errorMessage: err.message,
          stack: err.stack,
        });
      } else {
        log.error("Session importance background task failed", { error: String(err) });
      }
    });
  }
};

export default sessionImportanceHandler;
