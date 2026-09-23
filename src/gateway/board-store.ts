import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

export function captureGatewaySessionStoreScope(sessionKey: string, explicitAgentId?: string) {
  const cfg = getRuntimeConfig();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: explicitAgentId,
  });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return { agentId, storePath, sessionKey: canonicalKey };
}

export function resolveGatewaySessionDatabase(
  sessionKey: string,
  explicitAgentId?: string,
): {
  agentId: string;
  path?: string;
  sessionKey: string;
} {
  const {
    agentId,
    storePath,
    sessionKey: canonicalKey,
  } = captureGatewaySessionStoreScope(sessionKey, explicitAgentId);
  const databaseTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  // Shared stores keep logical session keys under their persisted database owner.
  return {
    agentId: databaseTarget.agentId ?? agentId,
    path: databaseTarget.path,
    sessionKey: canonicalKey,
  };
}

export const boardStore = new SqliteBoardStore({
  resolveSession: ({ sessionKey, agentId }) => resolveGatewaySessionDatabase(sessionKey, agentId),
});
