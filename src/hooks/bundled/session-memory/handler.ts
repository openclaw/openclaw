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
import { SafeOpenError, writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

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
 * Canonicalize an absolute path by walking up to the nearest existing ancestor
 * and resolving symlinks from there. Handles cases like macOS /tmp → /private/tmp
 * where the target file (or its parent dirs) don't exist yet.
 *
 * WARNING: This is a symlink-resolution helper only. The output is NOT guaranteed
 * to be workspace-confined — callers MUST validate containment separately
 * (e.g., via writeFileWithinRoot).
 */
async function canonicalizeViaAncestor(absPath: string): Promise<string> {
  let current = absPath;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch {
      suffix.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) {
        return absPath;
      } // reached filesystem root
      current = parent;
    }
  }
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
    // Ensure workspace root exists — writeFileWithinRoot creates subdirectories
    // but requires the root to be present (resolvePathWithinRoot calls realpath
    // on it). This is normally a no-op since the workspace is created at startup.
    await fs.mkdir(workspaceDir, { recursive: true });

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

    // Short-circuit transcript loading and LLM slug generation when
    // blockSessionSave is already set — no point loading sensitive content
    // or sending it to a model provider when saving is explicitly blocked.
    const blockPreSet = context.blockSessionSave === true;

    const redirectPath = context.sessionSaveRedirectPath;
    const isRedirected = typeof redirectPath === "string" && redirectPath.length > 0;

    // Known limitation: if an earlier hook pre-sets sessionSaveContent and
    // a later hook *clears* it (expecting a revert to the default
    // transcript), the transcript is not available — it was never loaded
    // because hasCustomContent was true at this point.  The post-hook
    // cannot fall back to the default entry without re-reading the session
    // file and re-running slug generation.  In practice, hooks that want
    // to override earlier custom content should set their own
    // sessionSaveContent rather than clearing it.
    if (sessionFile && !hasCustomContent && !blockPreSet) {
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

      // Skip LLM slug generation when redirect path is set — the slug is only
      // used for the default filename, which is unused when isRedirected is true.
      if (sessionContent && cfg && allowLlmSlug && !isRedirected) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // Slug and filename are only needed for non-redirected writes —
    // redirected writes use the caller-supplied path directly.
    let filename = "";
    if (!isRedirected) {
      // If no slug, use timestamp with a random suffix to avoid collisions.
      // Second-resolution (HHMMSS) alone can collide when automated or
      // multi-channel setups emit rapid /new or /reset commands within the
      // same second — both writes target the same filename and the later
      // one silently overwrites the earlier memory entry.
      if (!slug) {
        const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
        const rand = Math.random().toString(36).slice(2, 6); // 4-char alphanumeric
        slug = `${timeSlug.slice(0, 6)}-${rand}`;
        log.debug("Using fallback timestamp slug", { slug });
      }
      filename = `${dateStr}-${slug}.md`;
    }

    // Determine write target. Redirect paths are validated by writeFileWithinRoot
    // which handles path traversal, symlink resolution, and containment checks.
    // For redirects, compute a workspace-relative path so writeFileWithinRoot
    // can validate containment. Both workspace and redirect paths are
    // canonicalized via realpath to avoid symlink aliasing issues.
    // Canonicalize workspace for all redirected writes (absolute and relative)
    // so that writeFileWithinRoot's containment check and the post-write log
    // path use a consistent root.
    const canonicalWorkspace = isRedirected
      ? await fs.realpath(workspaceDir).catch(() => workspaceDir)
      : workspaceDir;
    // Canonicalize the redirect path by walking up to the nearest existing
    // ancestor. This handles macOS /tmp → /private/tmp symlinks and other
    // cases where the redirect target's parent doesn't exist yet.
    let canonicalRedirect = redirectPath as string;
    if (isRedirected && path.isAbsolute(redirectPath)) {
      canonicalRedirect = await canonicalizeViaAncestor(redirectPath);
    }
    const writeRelativePath = isRedirected
      ? path.isAbsolute(redirectPath)
        ? path.relative(canonicalWorkspace, canonicalRedirect)
        : redirectPath
      : path.join("memory", filename);

    log.debug("Memory file path resolved", {
      filename,
      redirected: isRedirected,
      relativePath: writeRelativePath,
    });

    // memoryDir and memoryFilePath are only used for non-redirected writes.
    const memoryDir = path.join(workspaceDir, "memory");
    const memoryFilePath = path.join(memoryDir, filename);

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
    } else if (isRedirected) {
      // Write session memory to redirect path — writeFileWithinRoot handles
      // path traversal, symlink resolution, and containment validation.
      // If a redirect path fails validation, the handler fails closed
      // (no fallback to default memory dir — this is a security decision).
      //
      // Write scope: redirect paths use workspace/ as root (not memory/) to
      // allow quarantine directories outside memory/. Non-redirects use memory/.
      try {
        await writeFileWithinRoot({
          rootDir: canonicalWorkspace,
          relativePath: writeRelativePath,
          data: entry,
          encoding: "utf-8",
        });
      } catch (err) {
        if (err instanceof SafeOpenError) {
          log.warn("Redirect path rejected — failing closed (no fallback)", {
            redirectPath,
            reason: err.message,
          });
          return;
        }
        throw err;
      }
      log.debug("Memory file written successfully (redirected)");
      // Use canonicalWorkspace (always realpath'd for redirects) so the
      // logged path is consistent regardless of symlinks.
      const writePath = path.resolve(canonicalWorkspace, writeRelativePath);
      const relPath = writePath.replace(os.homedir(), "~");
      log.info(`Session context saved to ${relPath}`);
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
    //
    // blockSessionSave is honored for ALL writes (including redirects) —
    // it's a security primitive meaning "no persistence, period" and must
    // win regardless of where the write was directed.
    //
    // sessionSaveContent replacement is only applied for non-redirected
    // writes — redirect paths are a security contract where the hook
    // explicitly chose an alternative location and content; overriding
    // content in post-hook would undermine the redirect contract.
    const writtenEntry = context.blockSessionSave === true ? null : entry;
    const writtenFilePath = isRedirected
      ? path.resolve(canonicalWorkspace, writeRelativePath)
      : memoryFilePath;

    // Post-hook callback — errors propagate to the framework's per-action
    // catch in triggerInternalHook, which provides consistent log formatting
    // and per-action isolation.
    event.postHookActions.push(async () => {
      // If a later hook blocked the save, retract the file we just wrote.
      // This applies to both redirected and non-redirected writes —
      // blockSessionSave means "no persistence anywhere."
      if (event.context.blockSessionSave === true && writtenEntry !== null) {
        try {
          await fs.unlink(writtenFilePath);
          log.debug("Session save retracted by post-hook (blockSessionSave)", {
            redirected: isRedirected,
          });
        } catch (err) {
          // File may not exist if inline write also didn't happen — that's fine.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
        return;
      }

      // sessionSaveContent replacement only for non-redirected writes.
      // Redirect hooks chose the target path and content; a later hook
      // shouldn't silently overwrite that decision.
      if (isRedirected) {
        return;
      }

      // If a later hook set sessionSaveContent, overwrite with new content.
      // blockSessionSave takes precedence — never create/overwrite a file that
      // was blocked, even if sessionSaveContent is also set.
      const postContent = event.context.sessionSaveContent;
      if (
        event.context.blockSessionSave !== true &&
        typeof postContent === "string" &&
        postContent !== writtenEntry
      ) {
        // Ensure memoryDir exists — the inline write may have been
        // skipped (e.g. blockSessionSave was true initially) so mkdir
        // might never have run.
        await fs.mkdir(memoryDir, { recursive: true });
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
