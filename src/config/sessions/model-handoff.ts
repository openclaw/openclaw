import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sessions/model-handoff");

/**
 * Maximum number of recent user messages to include in a handoff.
 * Only user-authored messages are extracted — assistant responses are excluded
 * to prevent behavioral pattern contamination from the previous model.
 */
const MAX_HANDOFF_USER_MESSAGES = 5;

/** Maximum character length per extracted user message. */
const MAX_MESSAGE_CHARS = 200;

/** Maximum age of handoff files before auto-cleanup (30 days). */
const HANDOFF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum number of archived handoff files to retain per session directory. */
const HANDOFF_MAX_FILES = 5;

export type SessionHandoff = {
  /** ISO timestamp when the model switch occurred. */
  switchedAt: string;
  /** Previous model identifier (e.g. "minimax/MiniMax-Text-01"). */
  previousModel?: string;
  /** Previous provider identifier. */
  previousProvider?: string;
  /** New model identifier that is taking over. */
  newModel?: string;
  /** Session key this handoff applies to. */
  sessionKey: string;
  /** Recent user messages extracted from the old transcript (most recent last). */
  recentUserMessages: string[];
  /** Path to the archived transcript file. */
  archivePath?: string;
};

type TranscriptLine = {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    provenance?: { kind?: string };
  };
};

/**
 * Extract recent user messages from a session transcript file.
 * Only reads user-role messages, ignoring assistant responses and tool calls
 * to avoid carrying over model-specific behavioral patterns.
 */
export function extractUserMessagesFromTranscript(
  transcriptPath: string,
  maxMessages = MAX_HANDOFF_USER_MESSAGES,
  maxChars = MAX_MESSAGE_CHARS,
): string[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const userMessages: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TranscriptLine;
      const msg = parsed?.message;
      if (!msg || msg.role !== "user") {
        continue;
      }
      // Skip inter-session forwarded messages
      if (
        msg.provenance &&
        typeof msg.provenance === "object" &&
        (msg.provenance as { kind?: string }).kind === "inter_session"
      ) {
        continue;
      }
      const text = extractTextContent(msg.content);
      if (text) {
        const trimmed = text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
        userMessages.push(trimmed);
      }
    } catch {
      // skip malformed lines
    }
  }

  // Return only the most recent N messages
  return userMessages.slice(-maxMessages);
}

function extractTextContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part.text === "string" &&
        (part.type === "text" || part.type === "input_text")
      ) {
        const trimmed = part.text.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve the handoff file path for a given session directory and session key.
 * Handoff files are stored as `handoff-<sanitized-key>.json` in the sessions directory.
 */
export function resolveHandoffPath(sessionsDir: string, sessionKey: string): string {
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return path.join(sessionsDir, `handoff-${safeKey}.json`);
}

/**
 * Create a model handoff file from a session transcript.
 * Extracts user messages and writes a structured handoff JSON.
 */
export function createModelHandoff(params: {
  sessionsDir: string;
  sessionKey: string;
  transcriptPath: string;
  previousModel?: string;
  previousProvider?: string;
  newModel?: string;
  archivePath?: string;
}): SessionHandoff | null {
  const userMessages = extractUserMessagesFromTranscript(params.transcriptPath);
  if (userMessages.length === 0) {
    return null;
  }

  const handoff: SessionHandoff = {
    switchedAt: new Date().toISOString(),
    previousModel: params.previousModel,
    previousProvider: params.previousProvider,
    newModel: params.newModel,
    sessionKey: params.sessionKey,
    recentUserMessages: userMessages,
    archivePath: params.archivePath,
  };

  const handoffPath = resolveHandoffPath(params.sessionsDir, params.sessionKey);
  try {
    fs.writeFileSync(handoffPath, JSON.stringify(handoff, null, 2), "utf-8");
  } catch (err) {
    log.warn(`failed to write handoff file: ${String(err)}`);
    return null;
  }

  return handoff;
}

/**
 * Read a model handoff file for a given session key, if one exists.
 * Returns null if no handoff file is found or if it's too old.
 */
export function readModelHandoff(
  sessionsDir: string,
  sessionKey: string,
): SessionHandoff | null {
  const handoffPath = resolveHandoffPath(sessionsDir, sessionKey);
  if (!fs.existsSync(handoffPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(handoffPath, "utf-8");
    const handoff = JSON.parse(raw) as SessionHandoff;

    // Validate basic structure
    if (!handoff.switchedAt || !Array.isArray(handoff.recentUserMessages)) {
      return null;
    }

    // Check age — discard stale handoffs
    const switchedAtMs = Date.parse(handoff.switchedAt);
    if (Number.isNaN(switchedAtMs) || Date.now() - switchedAtMs > HANDOFF_MAX_AGE_MS) {
      // Clean up stale handoff file
      try {
        fs.unlinkSync(handoffPath);
      } catch {
        // best-effort cleanup
      }
      return null;
    }

    return handoff;
  } catch {
    return null;
  }
}

/**
 * Consume (read + delete) a handoff file. Called after the handoff context
 * has been injected into the new session's first prompt.
 */
export function consumeModelHandoff(
  sessionsDir: string,
  sessionKey: string,
): SessionHandoff | null {
  const handoff = readModelHandoff(sessionsDir, sessionKey);
  if (!handoff) {
    return null;
  }

  const handoffPath = resolveHandoffPath(sessionsDir, sessionKey);
  try {
    fs.unlinkSync(handoffPath);
  } catch {
    // best-effort cleanup
  }

  return handoff;
}

/**
 * Build a prompt section from a handoff, suitable for injection into
 * the user's first message in the new session.
 */
export function buildHandoffPromptSection(handoff: SessionHandoff): string {
  const lines: string[] = [];
  lines.push("[Model Handoff Notice]");
  lines.push(
    `You are taking over from a previous model (${handoff.previousModel ?? "unknown"}).`,
  );
  lines.push("The previous conversation has been archived. The user's recent messages were:");
  lines.push("");

  for (const msg of handoff.recentUserMessages) {
    lines.push(`- "${msg}"`);
  }

  lines.push("");
  lines.push(
    "If the user refers to earlier work, pick up from where they left off based on their messages above.",
  );
  lines.push(
    "Execute tasks using your own approach — do not imitate any patterns from the previous model.",
  );

  return lines.join("\n");
}

/**
 * Clean up old handoff files from a sessions directory.
 * Removes files older than HANDOFF_MAX_AGE_MS and keeps at most HANDOFF_MAX_FILES.
 */
export function cleanupHandoffFiles(sessionsDir: string): number {
  let removed = 0;
  try {
    const entries = fs.readdirSync(sessionsDir);
    const handoffFiles = entries
      .filter((name) => name.startsWith("handoff-") && name.endsWith(".json"))
      .map((name) => {
        const fullPath = path.join(sessionsDir, name);
        try {
          const stat = fs.statSync(fullPath);
          return { name, fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const now = Date.now();
    for (let i = 0; i < handoffFiles.length; i++) {
      const file = handoffFiles[i];
      const isOld = now - file.mtimeMs > HANDOFF_MAX_AGE_MS;
      const isBeyondLimit = i >= HANDOFF_MAX_FILES;
      if (isOld || isBeyondLimit) {
        try {
          fs.unlinkSync(file.fullPath);
          removed++;
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // directory may not exist yet
  }
  return removed;
}
