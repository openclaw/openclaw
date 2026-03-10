import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

type BeforeResetSessionEntry = {
  sessionId?: string;
  sessionFile?: string;
} | null;

const MAX_BEFORE_RESET_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_BEFORE_RESET_TRANSCRIPT_LINES = 10_000;
const MAX_BEFORE_RESET_MESSAGES = 1_000;

async function readBoundedBeforeResetMessages(sessionFile: string): Promise<unknown[]> {
  const stat = await fs.stat(sessionFile);
  if (stat.size > MAX_BEFORE_RESET_TRANSCRIPT_BYTES) {
    logVerbose(
      `before_reset: transcript exceeds ${MAX_BEFORE_RESET_TRANSCRIPT_BYTES} bytes; skipping message extraction`,
    );
    return [];
  }

  const messages: unknown[] = [];
  let lineCount = 0;
  let bytesRead = 0;
  let truncated = false;
  const stream = createReadStream(sessionFile, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineCount += 1;
      bytesRead += Buffer.byteLength(line, "utf-8") + 1;
      if (
        lineCount > MAX_BEFORE_RESET_TRANSCRIPT_LINES ||
        bytesRead > MAX_BEFORE_RESET_TRANSCRIPT_BYTES ||
        messages.length >= MAX_BEFORE_RESET_MESSAGES
      ) {
        truncated = true;
        break;
      }
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        // Skip malformed transcript lines.
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (truncated) {
    logVerbose("before_reset: transcript parsing truncated to bounded limits");
  }

  return messages;
}

export async function emitBeforeResetPluginHook(params: {
  sessionKey?: string;
  previousSessionEntry?: BeforeResetSessionEntry;
  workspaceDir: string;
  reason: string;
  storePath?: string;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const prevEntry = params.previousSessionEntry;
  const sessionId = prevEntry?.sessionId;
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const pathOpts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  let sessionFile: string | undefined;

  try {
    let messages: unknown[] = [];
    if (sessionId) {
      sessionFile = resolveSessionFilePath(sessionId, prevEntry ?? undefined, pathOpts);
      try {
        messages = await readBoundedBeforeResetMessages(sessionFile);
      } catch (err: unknown) {
        logVerbose(`before_reset: failed reading transcript messages: ${String(err)}`);
      }
    } else if (prevEntry?.sessionFile) {
      logVerbose("before_reset: session file present without session id; skipping transcript read");
    } else {
      logVerbose("before_reset: no session file available, firing hook with empty messages");
    }
    await hookRunner.runBeforeReset(
      { sessionFile, messages, reason: params.reason },
      {
        agentId,
        sessionKey: params.sessionKey,
        sessionId,
        workspaceDir: params.workspaceDir,
      },
    );
  } catch (err: unknown) {
    logVerbose(`before_reset hook failed: ${String(err)}`);
  }
}
