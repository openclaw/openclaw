import fs from "node:fs";
import { updateSessionStoreEntry, type SessionEntry } from "../../config/sessions.js";
import { streamSessionTranscriptLines } from "../../config/sessions/transcript-stream.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionTranscriptCandidates } from "../../gateway/session-transcript-files.fs.js";
import { resolveSessionModelRef } from "../../gateway/session-utils.js";
import { logVerbose } from "../../globals.js";
import { generateConversationLabel } from "./conversation-label-generator.js";

const TITLE_INPUT_SEPARATOR = "\n---\n";
const MAX_TITLE_INPUT_CHARS = 4_000;
const MAX_TITLE_MESSAGE_CHARS = 1_000;

function buildTitlePrompt(maxChars: number): string {
  return (
    `Generate a concise, descriptive title (max ${maxChars} chars) for a conversation based on the user's messages below. ` +
    "Use the same language as the user's messages. Return ONLY the title, nothing else. No quotes, no prefixes."
  );
}

function hasStoredSessionTitle(
  entry: Pick<SessionEntry, "autoTitle" | "displayName" | "subject">,
): boolean {
  return Boolean(entry.autoTitle?.trim() || entry.displayName?.trim() || entry.subject?.trim());
}

function buildTitleInputExcerpt(userMessages: string[]): string {
  return userMessages
    .map((message) => message.slice(0, MAX_TITLE_MESSAGE_CHARS))
    .join(TITLE_INPUT_SEPARATOR)
    .slice(0, MAX_TITLE_INPUT_CHARS);
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
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): void {
  const {
    cfg,
    sessionKey,
    sessionEntry,
    storePath,
    agentId,
    agentDir,
    authProfileId,
    authProfileIdSource,
  } = params;
  const titleCfg = cfg.sessionTitle;

  if (titleCfg?.enabled !== true) {
    return;
  }

  if (hasStoredSessionTitle(sessionEntry)) {
    return;
  }

  const sessionId = sessionEntry.sessionId;
  if (!sessionId) {
    return;
  }

  const sessionModel = resolveSessionModelRef(cfg, sessionEntry, agentId);

  // Fire and forget — do not block the reply.
  generateAndPersistTitle({
    cfg,
    sessionKey,
    sessionId,
    sessionEntry,
    storePath,
    agentId,
    agentDir,
    sessionModelProvider: sessionModel.provider,
    sessionModelId: sessionModel.model,
    authProfileId,
    authProfileIdSource,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logVerbose(`session-title-generator: failed to generate title for ${sessionKey}: ${message}`);
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
  sessionModelProvider?: string;
  sessionModelId?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): Promise<void> {
  const {
    cfg,
    sessionKey,
    sessionId,
    sessionEntry,
    storePath,
    agentId,
    agentDir,
    sessionModelProvider,
    sessionModelId,
    authProfileId,
    authProfileIdSource,
  } = params;
  const titleCfg = cfg.sessionTitle;
  const turnsBeforeTitle = titleCfg?.turnsBeforeTitle ?? 3;

  const transcriptPath = findTranscriptPath(sessionId, storePath, sessionEntry.sessionFile);
  if (!transcriptPath) {
    return;
  }

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

  const inputExcerpt = buildTitleInputExcerpt(userMessages);
  const maxChars = titleCfg?.maxChars ?? 50;

  const title = await generateConversationLabel({
    userMessage: inputExcerpt,
    prompt: buildTitlePrompt(maxChars),
    cfg,
    agentId,
    agentDir,
    maxLength: maxChars,
    modelProvider: sessionModelProvider,
    modelId: sessionModelId,
    authProfileId,
    authProfileIdSource,
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

  for await (const line of streamSessionTranscriptLines(filePath)) {
    let msg: { role?: unknown; content?: unknown } | undefined;
    try {
      const record = JSON.parse(line) as { message?: { role?: unknown; content?: unknown } } | null;
      msg = record?.message;
    } catch {
      continue;
    }
    if (!msg || msg.role !== "user") {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text && /^\[OpenClaw heartbeat/i.test(text.trim())) {
      continue;
    }
    count++;
    if (messages.length < maxMessages && text) {
      messages.push(text);
    }
    if (count >= maxMessages) {
      break;
    }
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
