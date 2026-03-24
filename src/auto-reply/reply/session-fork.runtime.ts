import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionFilePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export function forkSessionFromParentRuntime(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
    { agentId: params.agentId, sessionsDir: params.sessionsDir },
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
    return null;
  }
  try {
    // Create a clean session file for the thread/topic — do NOT branch from the
    // parent transcript. Branching (createBranchedSession) copies the parent's
    // assistant messages and tool results into the child file but omits the user
    // messages that triggered them, producing an asymmetric, confusing context
    // that bleeds across threads. See github.com/openclaw/openclaw/issues/758.
    //
    // Thread sessions are already isolated by their session key (:topic:/:thread:
    // suffix) and their own JSONL file. The parent context is not needed here —
    // each thread should start with a clean slate, with only the workspace
    // bootstrap files (SOUL.md, AGENTS.md, etc.) providing shared context.
    const manager = SessionManager.open(parentSessionFile);
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: manager.getCwd(),
      parentSession: parentSessionFile,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}
