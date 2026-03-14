import crypto from "node:crypto";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import {
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushRelativePathForRun,
  resolveMemoryFlushSettings,
} from "../auto-reply/reply/memory-flush.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { type InternalHookEvent, registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveSessionModelRef } from "./session-utils.js";

/**
 * Register a hook to perform a memory flush before a session is reset or a new session is started.
 * Ensures that any durable memories are captured to disk before the transcript is archived/cleared.
 */
export function registerSessionResetMemoryFlushHook() {
  registerInternalHook("command:reset", handleResetFlush);
  registerInternalHook("command:new", handleResetFlush);
}

async function handleResetFlush(event: InternalHookEvent) {
  const cfg = loadConfig();
  const settings = resolveMemoryFlushSettings(cfg);
  if (!settings?.enabled) {
    return;
  }

  const entry = event.context.sessionEntry as SessionEntry | undefined;
  if (!entry || !entry.sessionId) {
    return;
  }

  // Skip flush if there's no tokens used at all (brand new session with no history)
  if ((entry.totalTokens ?? 0) === 0 && (entry.inputTokens ?? 0) === 0) {
    return;
  }

  logVerbose(`Triggering pre-reset memory flush for session: ${event.sessionKey}`);

  const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const { provider, model } = resolveSessionModelRef(cfg, entry, agentId);

  const nowMs = Date.now();
  const memoryFlushWritePath = resolveMemoryFlushRelativePathForRun({ cfg, nowMs });

  const flushSystemPrompt = [
    settings.systemPrompt,
    "The session is being reset; this is the final memory flush.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    // Run the memory flush agent. We use a longer timeout since this is a critical cleanup operation.
    await runEmbeddedPiAgent({
      sessionId: entry.sessionId,
      sessionKey: event.sessionKey,
      agentId,
      trigger: "memory",
      memoryFlushWritePath,
      prompt: resolveMemoryFlushPromptForRun({
        prompt: settings.prompt,
        cfg,
        nowMs,
      }),
      extraSystemPrompt: flushSystemPrompt,
      sessionFile: entry.sessionFile ?? "session.jsonl",
      workspaceDir,
      provider,
      model,
      timeoutMs: 60_000,
      runId: `flush-reset-${crypto.randomUUID()}`,
    });
    logVerbose(`Pre-reset memory flush completed for session: ${event.sessionKey}`);
  } catch (err) {
    // We log but don't re-throw, as we don't want to block the reset if the flush fails.
    logVerbose(`Pre-reset memory flush failed for session: ${event.sessionKey}: ${String(err)}`);
  }
}
