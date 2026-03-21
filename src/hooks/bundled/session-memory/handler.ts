/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import crypto from "node:crypto";
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

    // Short-circuit transcript loading and LLM slug generation when
    // blockSessionSave is already set — no point loading sensitive content
    // or sending it to a model provider when saving is explicitly blocked.
    const blockPreSet = context.blockSessionSave === true;

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

      if (sessionContent && cfg && allowLlmSlug) {
        log.debug("Calling generateSlugViaLLM...");
        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        log.debug("Generated slug", { slug });
      }
    }

    // If no slug, use a timestamp-based fallback. The uniqueSuffix appended
    // below handles collision avoidance for all paths (LLM and fallback).
    if (!slug) {
      const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
      slug = timeSlug.slice(0, 6);
      log.debug("Using fallback timestamp slug", { slug });
    }

    // Append a short random suffix to guarantee filename uniqueness.
    // LLM-generated slugs are descriptive but not unique — two similar
    // sessions on the same day can produce identical slugs, causing the
    // second write to silently overwrite the first. A 4-char hex suffix
    // (16 bits of entropy) makes collisions vanishingly unlikely even
    // under rapid automated /new or multi-channel workloads.
    const uniqueSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
    const filename = `${dateStr}-${slug}-${uniqueSuffix}.md`;
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
    // When blockPreSet is true, skip entry construction entirely — the inline
    // write won't happen and the value would be discarded.
    let entry: string;
    if (blockPreSet) {
      // Block takes precedence — skip entry construction entirely since the
      // inline write won't happen and the value would be discarded.
      entry = "";
      if (hasCustomContent) {
        log.debug(
          "blockSessionSave pre-set — sessionSaveContent was also set but will be ignored " +
            "(blockSessionSave takes precedence over sessionSaveContent)",
        );
      } else {
        log.debug("Session save blocked by upstream hook (inline check)");
      }
    } else if (hasCustomContent) {
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
        `- **Session Key**: ${displaySessionKey}`,
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
    //
    // Before writing, snapshot any pre-existing file content so that late-block
    // retraction can restore it instead of deleting — preventing accidental
    // erasure of prior memory files when LLM slugs collide on the same day.
    let preExistingContent: string | null = null;
    if (blockPreSet) {
      // Already logged above — nothing to write.
    } else {
      await fs.mkdir(memoryDir, { recursive: true });
      try {
        preExistingContent = await fs.readFile(memoryFilePath, "utf-8");
      } catch (err: unknown) {
        // File doesn't exist yet — normal case, nothing to preserve.
        // Rethrow non-ENOENT errors (EACCES, EISDIR, etc.) to avoid silently
        // losing preExistingContent, which would cause late-block retraction
        // to delete the file instead of restoring a prior session's history.
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw err;
        }
      }
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
    const inlineWriteHappened = !blockPreSet;
    const writtenEntry = inlineWriteHappened ? entry : null;
    // Post-hook callback — errors propagate to the framework's per-action
    // catch in triggerInternalHook, which provides consistent log formatting
    // and per-action isolation.
    event.postHookActions.push(async () => {
      // If a later hook blocked the save, retract the file we just wrote.
      // If the file existed before our write (slug collision), restore the
      // original content instead of deleting — avoids erasing prior history.
      if (event.context.blockSessionSave === true && inlineWriteHappened) {
        // Privacy note: late-set blockSessionSave retracts the file but does NOT
        // prevent transcript content from having already been sent to the LLM
        // provider for slug generation — but only when the transcript was actually
        // loaded (i.e. no custom content was pre-set). When hasCustomContent is
        // true, transcript loading and LLM calls were skipped entirely.
        if (!hasCustomContent && sessionContent) {
          // Only warn when transcript was actually loaded and potentially
          // sent to the LLM for slug generation. When sessionFile was null
          // or sessionContent failed to load, no data left the device.
          log.warn(
            "blockSessionSave was set by a late hook — memory file will be retracted, but " +
              "transcript content may have already been sent to the LLM provider for slug generation. " +
              "To prevent transcript processing entirely, set blockSessionSave before the " +
              "session-memory handler runs.",
          );
        }
        // Verify we're reverting our own write before touching the file.
        // A concurrent session (e.g. /new, /reset) may have written to the
        // same filename between our inline write and this post-hook drain.
        // If the current content doesn't match what we wrote, skip retraction
        // to avoid clobbering the other session's data.
        let currentContent: string | null = null;
        try {
          currentContent = await fs.readFile(memoryFilePath, "utf-8");
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            if (preExistingContent !== null) {
              // Our inline write overwrote a pre-existing entry (slug collision),
              // and the file was subsequently deleted externally. Restore the
              // prior session's content — it was lost to our inline overwrite.
              await writeFileWithinRoot({
                rootDir: memoryDir,
                relativePath: filename,
                data: preExistingContent,
                encoding: "utf-8",
              });
              log.debug(
                "Session save retracted by post-hook — pre-existing file restored after external deletion",
              );
            } else {
              // No prior content existed — file was externally deleted, nothing to restore.
              log.debug("Session save retraction skipped — file already removed");
            }
            return;
          }
          throw err;
        }

        if (currentContent !== writtenEntry) {
          // File content differs from what we wrote — another session has
          // written to this file since our inline write. Do not clobber.
          log.warn(
            "Session save retraction skipped — file was modified by another " +
              "session since our inline write (concurrent save detected)",
          );
          return;
        }

        if (preExistingContent !== null) {
          // Slug collision: another entry already existed at this filename
          // before our inline write. Restore the original content rather
          // than deleting — preserves the prior session's history.
          // writeFileWithinRoot errors (e.g. ENOENT if memoryDir was
          // removed after our inline write) are NOT swallowed — they
          // indicate a real filesystem inconsistency that must surface.
          await writeFileWithinRoot({
            rootDir: memoryDir,
            relativePath: filename,
            data: preExistingContent,
            encoding: "utf-8",
          });
          log.debug("Session save retracted by post-hook — pre-existing file restored");
        } else {
          await fs.unlink(memoryFilePath);
          log.debug("Session save retracted by post-hook (blockSessionSave)");
        }
        return;
      }

      // If a later hook set sessionSaveContent, overwrite with new content.
      // blockSessionSave takes precedence — never create/overwrite a file that
      // was blocked, even if sessionSaveContent is also set.
      const postContent = event.context.sessionSaveContent;
      if (
        event.context.blockSessionSave !== true &&
        typeof postContent === "string" &&
        // Two distinct intents: write if no inline write happened (writtenEntry
        // is null because blockPreSet was true) OR if the content changed.
        (writtenEntry === null || postContent !== writtenEntry)
      ) {
        // Verify ownership before overwriting — if another concurrent run wrote
        // to the same file since our inline write, do not clobber their content.
        // Same TOCTOU guard as the late-block retraction path.
        if (writtenEntry !== null) {
          let currentContent: string | null = null;
          try {
            currentContent = await fs.readFile(memoryFilePath, "utf-8");
          } catch (err: unknown) {
            if (
              err instanceof Error &&
              "code" in err &&
              (err as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              // File was externally deleted — safe to recreate with new content.
              currentContent = null;
            } else {
              throw err;
            }
          }
          if (currentContent !== null && currentContent !== writtenEntry) {
            log.warn(
              "Session save content replacement skipped — file was modified by another " +
                "session since our inline write (concurrent save detected)",
            );
            return;
          }
        }

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
      } else if (
        event.context.blockSessionSave !== true &&
        writtenEntry === null &&
        typeof postContent !== "string"
      ) {
        // blockSessionSave was pre-set (causing writtenEntry=null and no inline
        // write), then a later hook cleared it without providing sessionSaveContent.
        // The transcript was never loaded, so we cannot produce a file. Warn so
        // plugin authors know to supply content when un-blocking.
        log.warn(
          "blockSessionSave was cleared but no sessionSaveContent provided — " +
            "no memory file written. Transcript was not loaded because " +
            "sessionSaveContent or blockSessionSave was pre-set during handler " +
            "execution. To write a file after clearing blockSessionSave, also " +
            "provide sessionSaveContent with the desired content.",
        );
      } else if (
        event.context.blockSessionSave !== true &&
        writtenEntry !== null &&
        typeof postContent !== "string" &&
        hasCustomContent
      ) {
        // sessionSaveContent was pre-set (inline write used custom content),
        // then a later hook cleared it. The file retains the pre-set content.
        // This is a no-op — to revert to transcript content, the clearing hook
        // must provide its own sessionSaveContent. Log for diagnostics so
        // plugin authors know their clearing was silently ignored.
        log.debug(
          "sessionSaveContent was cleared by a post-hook but the inline write " +
            "already used the pre-set content. File retains pre-set content. " +
            "To override, set sessionSaveContent to the desired replacement.",
        );
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
