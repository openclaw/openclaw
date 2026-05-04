import fs from "node:fs";
import { updateSessionStoreEntry, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionTranscriptCandidates } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { generateConversationLabel } from "./conversation-label-generator.js";

function buildTitlePrompt(maxChars: number): string {
  return (
    `Generate a concise, descriptive title (max ${maxChars} chars) for a conversation based on the user's messages below. ` +
    "Use the same language as the user's messages. Return ONLY the title, nothing else. No quotes, no prefixes."
  );
}

/**
 * Fire-and-forget: check if an AI-generated session title is needed and generate it.
 * Called after each successful reply. Returns immediately without blocking.
 */
export function maybeGenerateSessionTitle(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry: SessionEntry;
  storePath: string;
  agentId?: string;
  agentDir?: string;
  provider?: string;
  model?: string;
}): void {
  const { cfg, sessionKey, sessionEntry, storePath, agentId, agentDir, provider, model } = params;
  const titleCfg = cfg.sessionTitle;

  // Feature disabled.
  if (titleCfg?.enabled === false) {
    return;
  }

  // Already have a title.
  if (sessionEntry.autoTitle) {
    return;
  }

  const sessionId = sessionEntry.sessionId;
  if (!sessionId) {
    return;
  }

  // Fire and forget — do not block the reply.
  generateAndPersistTitle({
    cfg,
    sessionKey,
    sessionId,
    sessionEntry,
    storePath,
    agentId,
    agentDir,
    provider,
    model,
  }).catch((err) => {
    logVerbose(`session-title-generator: failed to generate title for ${sessionKey}: ${err}`);
  });
}

async function generateAndPersistTitle(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  sessionEntry: SessionEntry;
  storePath: string;
  agentId?: string;
  agentDir?: string;
  provider?: string;
  model?: string;
}): Promise<void> {
  const {
    cfg,
    sessionKey,
    sessionId,
    sessionEntry,
    storePath,
    agentId,
    agentDir,
    provider,
    model,
  } = params;
  const titleCfg = cfg.sessionTitle;
  const turnsBeforeTitle = titleCfg?.turnsBeforeTitle ?? 3;

  const transcriptPath = findTranscriptPath(sessionId, storePath, sessionEntry.sessionFile);
  if (!transcriptPath) {
    return;
  }

  // Read first chunk of transcript to extract user messages and count turns.
  let userMessages: string[];
  let userMessageCount: number;
  try {
    const result = await readUserMessagesFromTranscriptHead(transcriptPath, turnsBeforeTitle + 2);
    userMessages = result.messages;
    userMessageCount = result.count;
  } catch {
    logVerbose(`session-title-generator: failed to read transcript for ${sessionKey}`);
    return;
  }

  if (userMessageCount < turnsBeforeTitle) {
    return;
  }

  if (userMessages.length === 0) {
    return;
  }

  const combinedMessages = userMessages.join("\n---\n");
  const maxChars = titleCfg?.maxChars ?? 50;

  const title = await generateConversationLabel({
    userMessage: combinedMessages,
    prompt: buildTitlePrompt(maxChars),
    cfg,
    agentId,
    agentDir,
    maxLength: maxChars,
    provider,
    model,
  });

  if (!title) {
    return;
  }

  // Persist the generated title.
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async () => ({ autoTitle: title }),
  });

  logVerbose(`session-title-generator: generated title "${title}" for ${sessionKey}`);
}

function findTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);
  return (
    candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/**
 * Reads the head of a transcript file, extracts user message texts, and counts total user messages.
 */
async function readUserMessagesFromTranscriptHead(
  filePath: string,
  maxMessages: number,
): Promise<{ messages: string[]; count: number }> {
  const messages: string[] = [];
  let count = 0;

  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return { messages: [], count: 0 };
    }
    const chunk = buffer.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message;
        if (!msg || msg.role !== "user") {
          continue;
        }
        count++;
        if (messages.length < maxMessages) {
          const text = extractTextFromContent(msg.content);
          if (text) {
            messages.push(text);
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { messages, count };
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const text = part.text.trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}
