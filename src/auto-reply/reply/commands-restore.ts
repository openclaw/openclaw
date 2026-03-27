import path from "node:path";
import { listRecentArchives, performSessionRestore } from "../../gateway/session-restore.js";
import { logVerbose } from "../../globals.js";
import { emitResetCommandHooks } from "./commands-core.js";
import type { CommandHandler } from "./commands-types.js";

const MAX_PREVIEW_LENGTH = 80;

function truncatePreview(text: string): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_PREVIEW_LENGTH) {
    return oneLine;
  }
  return `${oneLine.slice(0, MAX_PREVIEW_LENGTH)}...`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${minutes}`;
}

export const handleRestoreCommand: CommandHandler = async (params, allowTextCommands) => {
  const cmd = params.command.commandBodyNormalized;
  const isRestore = cmd === "/restore" || cmd.startsWith("/restore ");
  if (!isRestore) {
    return null;
  }

  if (!allowTextCommands) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /restore from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!params.storePath) {
    return {
      shouldContinue: false,
      reply: { text: "Session restore unavailable (missing store path)." },
    };
  }

  const sessionsDir = path.dirname(params.storePath);
  const sessionKey = params.sessionKey;
  const arg = cmd.slice("/restore".length).trim();

  // /restore (no args) — list recent archives
  if (!arg) {
    const archives = listRecentArchives({ sessionsDir, sessionKey });
    if (archives.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "No archived sessions found for this channel." },
      };
    }

    const lines = archives.map((a) => {
      const preview = a.firstUserMessage
        ? `"${truncatePreview(a.firstUserMessage)}"`
        : "(empty session)";
      return `${a.index}. [${formatTimestamp(a.timestamp)}] ${preview}`;
    });

    const text = `Recent archived sessions:\n\n${lines.join("\n")}\n\nUse /restore <number> to restore.`;
    return { shouldContinue: false, reply: { text } };
  }

  // /restore <number> — restore a specific archive
  const num = Number.parseInt(arg, 10);
  if (Number.isNaN(num) || num < 1) {
    return {
      shouldContinue: false,
      reply: { text: "Usage: /restore or /restore <number>" },
    };
  }

  const archives = listRecentArchives({ sessionsDir, sessionKey });
  if (archives.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "No archived sessions found for this channel." },
    };
  }

  const selected = archives.find((a) => a.index === num);
  if (!selected) {
    return {
      shouldContinue: false,
      reply: { text: `Invalid number. Use a number between 1 and ${archives.length}.` },
    };
  }

  // Fire before_reset hooks so channels relying on pre-reset processing
  // (e.g. memory extraction) run before the active session is archived.
  if (!params.command.resetHookTriggered) {
    await emitResetCommandHooks({
      action: "new",
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey,
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
  }

  const result = await performSessionRestore({
    key: sessionKey,
    archiveFilePath: selected.filePath,
    sessionsDir,
    commandSource: "restore",
    topicId: params.ctx.MessageThreadId,
  });

  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `Restore failed: ${result.error}` },
    };
  }

  const preview = selected.firstUserMessage
    ? `"${truncatePreview(selected.firstUserMessage)}"`
    : "(empty session)";
  return {
    shouldContinue: false,
    reply: { text: `Session restored: ${preview}` },
  };
};
