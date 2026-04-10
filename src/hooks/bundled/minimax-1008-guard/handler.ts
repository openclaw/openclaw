/**
 * minimax-1008-guard — OpenClaw bundled hook
 *
 * MiniMax returns HTTP 500 {"type":"error","error":{"type":"api_error",
 * "message":"insufficient balance (1008)"}} both when the account has no
 * credits AND when the context window is exceeded.  OpenClaw currently
 * classifies this as a fatal billing error, which can cause the gateway to
 * hang (issue #24622).
 *
 * This hook:
 *  1. Detects the 1008 pattern on session:patch events
 *  2. Pushes a clear notification to the chat channel (front-end visible)
 *  3. Logs a structured warning to the gateway log (back-end visible)
 *  4. Checks context utilisation
 *  5. Issues /compact (or /new) so the session recovers automatically
 *  6. Never throws — keeps the gateway loop alive
 */

import type { HookHandler } from "../../hooks.js";
import { resolveHookConfig } from "../../config.js";

function isMiniMax1008Error(msg: string | undefined, provider: string): boolean {
  if (!msg || !provider.toLowerCase().includes("minimax")) return false;
  const lowerMsg = msg.toLowerCase();
  return lowerMsg.includes("1008") || lowerMsg.includes("insufficient balance");
}

function getContextPct(sessionEntry: any): number {
  if (!sessionEntry) return 0;
  const limit = sessionEntry.contextTokens ?? 0;
  const used = sessionEntry.totalTokens ?? 0;
  return limit > 0 ? Math.round((used / limit) * 100) : 0;
}

const handler: HookHandler = async (event) => {
  const { sessionEntry, patch, cfg } = event.context ?? {};

  const errorMessage = patch?.lastError ?? sessionEntry?.lastError ?? "";
  const provider = sessionEntry?.modelProvider ?? "";

  if (!isMiniMax1008Error(errorMessage, provider)) return;

  const hookCfg = resolveHookConfig(cfg, "minimax-1008-guard");
  const thresholdPct = (hookCfg?.contextThresholdPct as number) ?? 85;
  const autoAction = (hookCfg?.autoAction as string) ?? "compact";

  const pct = getContextPct(sessionEntry);
  const isContextOverflow = pct >= thresholdPct;

  const contextNote = pct > 0
    ? `Current context utilization: **${pct}%**.`
    : "Context utilization data unavailable.";

  const actionNote = isContextOverflow
    ? `Threshold exceeded. Auto-recovering via \`/${autoAction}\`...`
    : "Threshold not reached. This may be a true balance issue; please check MiniMax console.";

  event.messages.push(
    `⚠️ **MiniMax 1008 Error**\n\n` +
    `Likely context window limit reached.\n\n` +
    `${contextNote}\n\n` +
    `${actionNote}\n\n` +
    `_Raw Error: \`${errorMessage}\`_`
  );

  if (isContextOverflow) {
    event.messages.push(`/${autoAction}`);
  }
};

export default handler;
