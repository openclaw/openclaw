import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../config/sessions.js";
import { logVerbose } from "../globals.js";
import { ensureContextEnginesInitialized } from "./init.js";
import { resolveContextEngine } from "./registry.js";

export type BeforeSessionResetReason = "new" | "reset";

export async function runBeforeSessionResetLifecycle(params: {
  cfg: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  storePath?: string;
  agentId?: string;
  reason: BeforeSessionResetReason;
}): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return;
  }

  let sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    try {
      sessionFile = resolveSessionFilePath(
        sessionId,
        params.sessionEntry,
        resolveSessionFilePathOptions({
          agentId: params.agentId,
          storePath: params.storePath,
        }),
      );
    } catch (err) {
      logVerbose(
        `[context-engine] beforeSessionReset skipped: unable to resolve session file for ${sessionId}: ${String(err)}`,
      );
      return;
    }
  }

  if (!sessionFile) {
    return;
  }

  try {
    ensureContextEnginesInitialized();
    const contextEngine = await resolveContextEngine(params.cfg);
    if (typeof contextEngine.beforeSessionReset !== "function") {
      await contextEngine.dispose?.();
      return;
    }
    try {
      await contextEngine.beforeSessionReset({
        sessionId,
        sessionKey: params.sessionKey,
        sessionFile,
        reason: params.reason,
      });
    } finally {
      await contextEngine.dispose?.();
    }
  } catch (err) {
    logVerbose(`[context-engine] beforeSessionReset failed for ${sessionId}: ${String(err)}`);
  }
}
