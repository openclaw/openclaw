import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";

/** Tail kept so DM continuity survives silent session rotations. */
export const DEFAULT_REPLAY_MAX_MESSAGES = 6;

type SessionRecord = { message?: { role?: unknown } };

/**
 * Copy the tail of user/assistant JSONL records from a prior transcript into a
 * freshly-rotated one. Tool, system, and compaction records are skipped so
 * replay cannot reshape tool/role ordering. Returns 0 on any error.
 */
export function replayRecentUserAssistantMessages(params: {
  sourceTranscript?: string;
  targetTranscript: string;
  newSessionId: string;
  maxMessages?: number;
}): number {
  const max = Math.max(0, params.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  const src = params.sourceTranscript;
  if (max === 0 || !src || !fs.existsSync(src)) {
    return 0;
  }
  try {
    const kept: string[] = [];
    for (const line of fs.readFileSync(src, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const role = (JSON.parse(line) as SessionRecord | null)?.message?.role;
        if (role === "user" || role === "assistant") {
          kept.push(line);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    if (kept.length === 0) {
      return 0;
    }
    if (!fs.existsSync(params.targetTranscript)) {
      fs.mkdirSync(path.dirname(params.targetTranscript), { recursive: true });
      const header = JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.newSessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      });
      fs.writeFileSync(params.targetTranscript, `${header}\n`, { encoding: "utf-8", mode: 0o600 });
    }
    const tail = kept.slice(-max);
    fs.appendFileSync(params.targetTranscript, `${tail.join("\n")}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return tail.length;
  } catch {
    return 0;
  }
}
