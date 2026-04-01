import crypto from "node:crypto";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("commands/acp-close-self");

export async function handleAcpCloseSelf(opts: {
  sessionKey?: string;
  reason?: string;
  message?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = loadConfig();

  // Resolve session key: explicit flag, or auto-discover from cwd
  let sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    sessionKey = await discoverOwnAcpSessionKey(cfg);
  }
  if (!sessionKey) {
    return {
      ok: false,
      error:
        "Could not determine ACP session key. Pass --session-key explicitly or ensure this process runs inside an ACP session.",
    };
  }

  // Deliver handoff message to the conversation before unbinding
  if (opts.message?.trim()) {
    try {
      await callGateway({
        method: "agent",
        params: {
          message: opts.message.trim(),
          sessionKey,
          deliver: true,
          label: "handback",
          idempotencyKey: crypto.randomUUID(),
        },
        timeoutMs: 10_000,
      });
    } catch (err) {
      log.warn(`Failed to deliver handoff message for ${sessionKey}: ${String(err)}`);
      // Non-fatal: proceed with close
    }
  }

  // Delete the session (closes ACP runtime + unbinds)
  // The transcript is preserved so the main agent can reference it.
  try {
    await callGateway<{ ok: boolean; deleted: boolean }>({
      method: "sessions.delete",
      params: {
        key: sessionKey,
        deleteTranscript: false,
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to close session ${sessionKey}: ${String(err)}`,
    };
  }

  return { ok: true };
}

/**
 * Discover the current ACP session key by matching the cwd against active sessions.
 */
async function discoverOwnAcpSessionKey(
  _cfg: ReturnType<typeof loadConfig>,
): Promise<string | undefined> {
  const cwd = process.cwd();
  try {
    const sessions = await callGateway<{
      sessions?: Array<{ key: string; acp?: { cwd?: string; state?: string } }>;
    }>({
      method: "sessions.list",
      params: {},
      timeoutMs: 10_000,
    });

    if (!sessions?.sessions) {
      return undefined;
    }

    // Find an ACP session whose cwd matches ours
    const match = sessions.sessions.find(
      (s) => s.acp?.cwd && normalizePath(s.acp.cwd) === normalizePath(cwd),
    );
    return match?.key;
  } catch {
    return undefined;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, "");
}
