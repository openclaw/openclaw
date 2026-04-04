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
  hasMaterialContinuityChange,
  RECENT_CONTINUITY_LATEST,
  RECENT_CONTINUITY_SNAPSHOTS_DIR,
  renderContinuitySnapshotMarkdown,
} from "../../../../packages/memory-host-sdk/src/host/continuity.js";
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
import { generateContinuitySnapshotViaLLM } from "../../llm-session-memory.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { findPreviousSessionFile, getRecentSessionContentWithResetFallback } from "./transcript.js";

const log = createSubsystemLogger("hooks/session-memory");

function normalizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

async function readOptionalFile(pathname: string): Promise<string | undefined> {
  try {
    return await fs.readFile(pathname, "utf-8");
  } catch {
    return undefined;
  }
}

function buildRecentSnapshotState(params: {
  now: Date;
  validHours: number;
  source: string;
  project?: string;
  sessionKey: string;
  currentTask?: string;
  currentPhase?: string;
  latestUserRequest?: string;
  blockers?: string[];
  nextSteps?: string[];
  keyArtifacts?: string[];
  conversationSummary?: string;
  status?: string;
  priority?: string;
  supersedes?: string;
}): {
  status: string;
  priority: string;
  updatedAt: string;
  supersedes?: string;
  source: string;
  project: string;
  sessionKey: string;
  validUntil: string;
  currentTask: string;
  currentPhase: string;
  latestUserRequest: string;
  blockers: string[];
  nextSteps: string[];
  keyArtifacts: string[];
  conversationSummary?: string;
} {
  const updatedAt = params.now.toISOString();
  const validUntil = new Date(
    params.now.getTime() + params.validHours * 60 * 60 * 1000,
  ).toISOString();
  return {
    status: params.status ?? "active",
    priority: params.priority ?? "high",
    updatedAt,
    supersedes: params.supersedes,
    source: params.source,
    project: params.project?.trim() || "unknown",
    sessionKey: params.sessionKey,
    validUntil,
    currentTask: params.currentTask?.trim() || "unknown",
    currentPhase: params.currentPhase?.trim() || "unknown",
    latestUserRequest: params.latestUserRequest?.trim() || "unknown",
    blockers: normalizeList(params.blockers ?? []),
    nextSteps: normalizeList(params.nextSteps ?? []),
    keyArtifacts: normalizeList(params.keyArtifacts ?? []),
    conversationSummary: params.conversationSummary?.trim() || undefined,
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
 * Save session context to memory on reset pivots and compaction checkpoints.
 */
const saveSessionToMemory: HookHandler = async (event) => {
  const isResetCommand =
    event.type === "command" && (event.action === "new" || event.action === "reset");
  const isCompactionCheckpoint = event.type === "session" && event.action === "compact:before";
  if (!isResetCommand && !isCompactionCheckpoint) {
    return;
  }

  try {
    log.debug("Session memory hook triggered", { type: event.type, action: event.action });

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

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    // Prefer the pre-reset session on /new|/reset, otherwise use the active session
    // provided by the compaction checkpoint event.
    const sessionEntry = (
      isResetCommand ? context.previousSessionEntry || context.sessionEntry : context.sessionEntry
    ) as Record<string, unknown>;
    const currentSessionId =
      (sessionEntry?.sessionId as string) ||
      (typeof context.sessionId === "string" ? context.sessionId : undefined) ||
      "unknown";
    let currentSessionFile =
      (sessionEntry?.sessionFile as string) ||
      (typeof context.sessionFile === "string" ? context.sessionFile : undefined);

    // On /new|/reset we may need to walk back to the pre-rotation transcript.
    if (isResetCommand && (!currentSessionFile || currentSessionFile.includes(".reset."))) {
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
    const validHours =
      typeof hookConfig?.validHours === "number" && hookConfig.validHours > 0
        ? Math.floor(hookConfig.validHours)
        : 24;
    const writeArchive = hookConfig?.archive !== false;
    const writeRecent = hookConfig?.recent !== false;

    let slug: string | null = null;
    let sessionContent: string | null = null;
    let extractedContinuity: Awaited<ReturnType<typeof generateContinuitySnapshotViaLLM>> | null =
      null;

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
      const allowLlmExtract = !isTestEnv && hookConfig?.llmExtract !== false;

      if (sessionContent && cfg && allowLlmExtract) {
        extractedContinuity = await generateContinuitySnapshotViaLLM({
          sessionContent,
          cfg,
        });
      }

      if (sessionContent && cfg && allowLlmSlug) {
        slug = extractedContinuity?.slug ?? (await generateSlugViaLLM({ sessionContent, cfg }));
        log.debug("Generated slug", {
          slug,
          usedContinuityExtract: Boolean(extractedContinuity?.slug),
        });
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
      slug = timeSlug.slice(0, 4); // HHMM
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Extract context details
    const sessionId = currentSessionId || "unknown";
    const source = isResetCommand ? (context.commandSource as string) || "command" : "compaction";

    if (writeArchive && isResetCommand) {
      const filename = `${dateStr}-${slug}.md`;
      const memoryFilePath = path.join(memoryDir, filename);
      log.debug("Memory file path resolved", {
        filename,
        path: memoryFilePath.replace(os.homedir(), "~"),
      });

      const timeStr = now.toISOString().split("T")[1].split(".")[0];
      const entryParts = [
        `# Session: ${dateStr} ${timeStr} UTC`,
        "",
        `- **Session Key**: ${displaySessionKey}`,
        `- **Session ID**: ${sessionId}`,
        `- **Source**: ${source}`,
        "",
      ];

      if (sessionContent) {
        entryParts.push("## Conversation Summary", "", sessionContent, "");
      }

      const entry = entryParts.join("\n");
      await writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: filename,
        data: entry,
        encoding: "utf-8",
      });
      log.info(`Session context saved to ${memoryFilePath.replace(os.homedir(), "~")}`);
    }

    if (writeRecent) {
      const latestRelativePath = RECENT_CONTINUITY_LATEST;
      const latestAbsPath = path.join(workspaceDir, latestRelativePath);
      const previousLatest = await readOptionalFile(latestAbsPath);
      const snapshotState = buildRecentSnapshotState({
        now,
        validHours,
        source: `session-memory:${source}`,
        project: extractedContinuity?.project,
        sessionKey: displaySessionKey,
        currentTask: extractedContinuity?.currentTask,
        currentPhase: extractedContinuity?.currentPhase,
        latestUserRequest: extractedContinuity?.latestUserRequest,
        blockers: extractedContinuity?.blockers,
        nextSteps: extractedContinuity?.nextSteps,
        keyArtifacts: extractedContinuity?.keyArtifacts,
        conversationSummary:
          extractedContinuity?.conversationSummary ?? sessionContent ?? undefined,
        status: extractedContinuity?.status,
        priority: extractedContinuity?.priority,
        supersedes: previousLatest ? latestRelativePath : undefined,
      });

      if (hasMaterialContinuityChange(previousLatest, snapshotState)) {
        const snapshotFileName = `${dateStr}-${now
          .toISOString()
          .split("T")[1]
          .split(".")[0]
          .replace(/:/g, "")}-${slug}.md`;
        const snapshotRelativePath = `${RECENT_CONTINUITY_SNAPSHOTS_DIR}/${snapshotFileName}`;
        const snapshotContent = renderContinuitySnapshotMarkdown(snapshotState);
        await writeFileWithinRoot({
          rootDir: memoryDir,
          relativePath: snapshotRelativePath.replace(/^memory\//, ""),
          data: snapshotContent,
          encoding: "utf-8",
          mkdir: true,
        });
        await writeFileWithinRoot({
          rootDir: memoryDir,
          relativePath: latestRelativePath.replace(/^memory\//, ""),
          data: snapshotContent,
          encoding: "utf-8",
          mkdir: true,
        });
        log.info(`Recent continuity snapshot saved to ${snapshotRelativePath}`);
      } else {
        log.debug(
          "Skipping recent continuity snapshot write because state did not change materially",
        );
      }
    }
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
