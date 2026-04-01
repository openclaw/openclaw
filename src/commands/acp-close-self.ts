import crypto from "node:crypto";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("commands/acp-close-self");

export async function handleAcpCloseSelf(opts: {
  sessionKey?: string;
  message?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return {
      ok: false,
      error:
        "Missing --session-key. The [ACP SESSION CONTROL] block in your task contains the key.",
    };
  }

  // Deliver handoff message and wait for it to land before closing.
  if (opts.message?.trim()) {
    try {
      const idempotencyKey = crypto.randomUUID();
      await callGateway({
        method: "agent",
        params: {
          message: opts.message.trim(),
          sessionKey,
          deliver: true,
          label: "handback",
          idempotencyKey,
        },
        timeoutMs: 10_000,
      });
      // Wait briefly for the message to be processed before deleting the session.
      await callGateway({
        method: "agent.wait",
        params: { idempotencyKey },
        timeoutMs: 15_000,
      }).catch(() => {
        // Best-effort: if wait times out the message may still land.
      });
    } catch (err) {
      log.warn(`Failed to deliver handoff message for ${sessionKey}: ${String(err)}`);
      // Non-fatal: proceed with close
    }
  }

  // Delete the session (closes ACP runtime + unbinds).
  // Transcript is preserved so the main agent can reference it.
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
