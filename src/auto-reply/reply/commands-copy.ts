import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { resolveSessionFilePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Copy text to the system clipboard.
 * Supports macOS (pbcopy) and Linux (xclip / xsel).
 */
function copyToClipboard(text: string): void {
  if (process.platform === "darwin") {
    execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
  } else {
    // Linux — try xclip first, then xsel
    try {
      execSync("xclip -selection clipboard", { input: text, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      execSync("xsel --clipboard --input", { input: text, stdio: ["pipe", "ignore", "ignore"] });
    }
  }
}

/**
 * Extract plain text from an assistant message's content array.
 * Handles both string content and typed content blocks.
 * Uses unknown + runtime checks to handle all AgentMessage variants safely.
 */
function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  // oxlint-disable-next-line typescript/no-explicit-any
  const msg = message as Record<string, any>;
  if (msg["role"] !== "assistant") {
    return null;
  }
  const content: unknown = msg["content"];
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        // oxlint-disable-next-line typescript/no-explicit-any
        const b = block as Record<string, any>;
        if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim()) {
          parts.push(b["text"].trim());
        }
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

/**
 * Handles `/copy` — copies the last assistant message to the clipboard.
 */
export const handleCopyCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();
  if (body !== "/copy") {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /copy from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Resolve session file
  const sessionEntry = params.sessionEntry;
  if (!sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No active session found." },
    };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[params.sessionKey] as SessionEntry | undefined;

  const sessionFile = (() => {
    const src = entry ?? sessionEntry;
    if (!src.sessionFile) {
      return null;
    }
    try {
      return resolveSessionFilePath(src.sessionId, src, {
        agentId: params.agentId,
        sessionsDir: path.dirname(storePath),
      });
    } catch {
      return src.sessionFile ?? null;
    }
  })();

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Session transcript not found." },
    };
  }

  // Load session entries and find the last assistant message
  const sessionManager = SessionManager.open(sessionFile);
  const branch = sessionManager.getBranch();

  let lastAssistantText: string | null = null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message) {
      const text = extractAssistantText(entry.message);
      if (text) {
        lastAssistantText = text;
        break;
      }
    }
  }

  if (!lastAssistantText) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No assistant message found in current session." },
    };
  }

  try {
    copyToClipboard(lastAssistantText);
    logVerbose(`/copy: copied ${lastAssistantText.length} chars to clipboard`);
    return {
      shouldContinue: false,
      reply: { text: "✅ Copied to clipboard!" },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to copy: ${msg}` },
    };
  }
};
