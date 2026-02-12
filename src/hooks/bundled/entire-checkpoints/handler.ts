/**
 * Entire Checkpoints hook handler
 *
 * Tracks AI coding sessions with Entire CLI checkpoints.
 * Maps OpenClaw lifecycle events to Entire's agent hook verbs.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HookHandler } from "../../hooks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("hooks/entire-checkpoints");
const execFileAsync = promisify(execFile);

/**
 * Resolve the path to the `entire` binary, or null if not found.
 */
async function findEntireBin(): Promise<string | null> {
  try {
    await execFileAsync("entire", ["--version"]);
    return "entire";
  } catch (err: unknown) {
    if ((err as Record<string, unknown>)?.code === "ENOENT") {
      return null;
    }
    // entire exists but --version failed? Still usable.
    return "entire";
  }
}

/**
 * Check if the workspace has Entire enabled (.entire/settings.json exists).
 */
function isEntireEnabled(workspaceDir: string | undefined): boolean {
  if (!workspaceDir) {
    return false;
  }
  try {
    return fs.existsSync(path.join(workspaceDir, ".entire", "settings.json"));
  } catch {
    return false;
  }
}

/**
 * Build the JSON payload to pipe to `entire hooks openclaw <verb>`.
 */
function buildPayload(event: Parameters<HookHandler>[0]): Record<string, unknown> {
  const context = event.context || {};
  // Use previousSessionEntry for command:new/reset (pre-reset session),
  // fall back to sessionEntry for other events
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
    string,
    unknown
  >;

  return {
    session_id: (sessionEntry.sessionId as string) || event.sessionKey,
    transcript_path: (sessionEntry.sessionFile as string) || undefined,
    prompt: (context.firstUserMessage as string) || undefined,
  };
}

/**
 * Call `entire hooks openclaw <verb>` with payload on stdin.
 */
async function callEntire(
  entireBin: string,
  verb: string,
  payload: Record<string, unknown>,
  workspaceDir?: string,
): Promise<void> {
  const args = ["hooks", "openclaw", verb];
  log.debug(`Calling: entire ${args.join(" ")}`);

  try {
    const child = execFileAsync(entireBin, args, {
      timeout: 10_000,
      env: { ...process.env },
      cwd: workspaceDir || process.cwd(),
    });

    // Pipe payload to stdin
    if (child.child.stdin) {
      child.child.stdin.write(JSON.stringify(payload));
      child.child.stdin.end();
    }

    await child;
    log.debug(`entire ${verb} completed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`entire ${verb} failed: ${msg}`);
  }
}

/**
 * Hook handler: dispatch OpenClaw events to Entire CLI.
 */
const entireCheckpoints: HookHandler = async (event) => {
  // Determine which verbs to call based on event
  let verbs: string[];

  if (event.type === "gateway" && event.action === "startup") {
    // Initialize session fully on startup so every subsequent commit gets checkpointed
    verbs = ["session-start", "user-prompt-submit"];
  } else if (event.type === "command" && (event.action === "new" || event.action === "reset")) {
    // Save checkpoint, end old session, start fresh
    verbs = ["stop", "session-end", "session-start", "user-prompt-submit"];
  } else if (event.type === "command" && event.action === "stop") {
    verbs = ["stop"];
  } else {
    return;
  }

  // Check if `entire` binary is available
  const entireBin = await findEntireBin();
  if (!entireBin) {
    log.debug("entire binary not found in PATH, skipping");
    return;
  }

  // Check if project has Entire enabled
  const workspaceDir = (event.context?.workspaceDir as string) || undefined;
  if (!isEntireEnabled(workspaceDir)) {
    log.debug("Entire not enabled for workspace, skipping");
    return;
  }

  const payload = buildPayload(event);

  for (const verb of verbs) {
    await callEntire(entireBin, verb, payload, workspaceDir);
  }
};

export default entireCheckpoints;
