import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import { updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type BootstrapSessionResult =
  | {
      ok: true;
      entry: SessionEntry;
      canonicalKey: string;
      storePath: string;
      wasCreated: boolean;
      contextOverflowed: boolean;
    }
  | { ok: false; error: { code: string; message: string } };

/**
 * Ensures an active session exists for the given agentId.
 * If one exists: returns it (idempotent).
 * If not: validates the agent config exists, then creates a fresh session.
 * Sets contextOverflowed=true if the previous dead session ended with full context.
 */
export async function bootstrapAgentSession(params: {
  agentId: string;
  force?: boolean;
  context: GatewayRequestContext;
}): Promise<BootstrapSessionResult> {
  const { agentId, force = false, context } = params;
  const cfg = loadConfig();
  const normalizedAgentId = normalizeAgentId(agentId);

  // Step 1: Check agent config is valid
  const { agents } = listGatewayAgentsBasic(cfg);
  const agentExists = agents.some((a) => a.id === normalizedAgentId);
  if (!agentExists) {
    return {
      ok: false,
      error: { code: "AGENT_NOT_FOUND", message: `agent not found: ${normalizedAgentId}` },
    };
  }

  // Step 2: Check if an active session already exists
  const mainKey = `agent:${normalizedAgentId}:main`;
  const target = resolveGatewaySessionStoreTarget({ cfg, key: mainKey });
  const existing = loadSessionEntry(mainKey);

  if (existing.entry?.sessionId && !force) {
    // Active session exists - return it as-is
    return {
      ok: true,
      entry: existing.entry,
      canonicalKey: existing.canonicalKey,
      storePath: existing.storePath,
      wasCreated: false,
      contextOverflowed: false,
    };
  }

  // Step 3: Detect context overflow from previous session
  // contextTokens >= contextWindow indicates overflow caused the session to die
  const contextOverflowed =
    !!existing.entry &&
    !existing.entry.sessionId &&
    !!existing.entry.contextTokens &&
    !!existing.entry.totalTokens &&
    existing.entry.totalTokensFresh === false;

  // Step 4: Create new session
  const created = await updateSessionStore(
    target.storePath,
    async (store: Record<string, SessionEntry>) => {
      return applySessionsPatchToStore({
        cfg,
        store,
        storeKey: target.canonicalKey,
        patch: { key: target.canonicalKey },
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    },
  );

  if (!created.ok) {
    return { ok: false, error: created.error };
  }

  const ensured = ensureSessionTranscriptFile({
    sessionId: created.entry.sessionId,
    storePath: target.storePath,
    sessionFile: created.entry.sessionFile,
    agentId: normalizedAgentId,
  });

  if (!ensured.ok) {
    await updateSessionStore(target.storePath, (store: Record<string, SessionEntry>) => {
      delete store[target.canonicalKey];
    });
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: `failed to create session transcript: ${ensured.error}`,
      },
    };
  }

  return {
    ok: true,
    entry: created.entry,
    canonicalKey: target.canonicalKey,
    storePath: target.storePath,
    wasCreated: true,
    contextOverflowed,
  };
}
