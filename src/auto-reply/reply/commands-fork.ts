import fs from "node:fs";
import path from "node:path";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

type ForkEntry = {
  forkId: string;
  forkName?: string;
  sourceSessionId: string;
  sourceSessionKey: string;
  agentId?: string;
  timestamp: number;
  createdAt: string;
};

/**
 * Resolve the path to the forks registry file.
 * Stored alongside sessions.json: `~/.openclaw/agents/{agentId}/forks.json`
 */
function resolveForksFilePath(agentId?: string): string {
  const storePath = resolveDefaultSessionStorePath(agentId);
  return path.join(path.dirname(storePath), "forks.json");
}

function loadForks(forksPath: string): ForkEntry[] {
  try {
    if (!fs.existsSync(forksPath)) {
      return [];
    }
    const raw = fs.readFileSync(forksPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ForkEntry[]) : [];
  } catch {
    return [];
  }
}

function saveForks(forksPath: string, forks: ForkEntry[]): void {
  fs.mkdirSync(path.dirname(forksPath), { recursive: true });
  fs.writeFileSync(forksPath, JSON.stringify(forks, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Handles `/fork [name]` — records a fork of the current session.
 *
 * A full history clone is deferred to the agent runner (complex), so this
 * simplified handler: records the fork point in `forks.json` and instructs
 * the user to use `/new` if they want a clean slate, or continue here.
 */
export const handleForkCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();
  if (body !== "/fork" && !body.startsWith("/fork ")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /fork from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const forkName = body.slice("/fork".length).trim() || undefined;
  const sessionId = params.sessionEntry?.sessionId;
  const sessionKey = params.sessionKey;
  const agentId = params.agentId;

  if (!sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "❌ No active session to fork." },
    };
  }

  // Record the fork
  const forkId = `fork-${Date.now().toString(36)}`;
  const forkEntry: ForkEntry = {
    forkId,
    forkName,
    sourceSessionId: sessionId,
    sourceSessionKey: sessionKey,
    agentId,
    timestamp: Date.now(),
    createdAt: new Date().toISOString(),
  };

  const forksPath = resolveForksFilePath(agentId);
  const forks = loadForks(forksPath);
  forks.push(forkEntry);
  saveForks(forksPath, forks);

  logVerbose(`/fork: recorded fork ${forkId} from session ${sessionId}`);

  const lines = [
    `🍴 **Fork recorded!**`,
    "",
    forkName ? `• Name: **${forkName}**` : "",
    `• Fork ID: \`${forkId}\``,
    `• Source session: \`${sessionId.slice(0, 8)}…\``,
    `• Recorded in: \`${forksPath}\``,
    "",
    "Continue here to stay on this branch, or use `/new` to start fresh.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    shouldContinue: false,
    reply: { text: lines },
  };
};
