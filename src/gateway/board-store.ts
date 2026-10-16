import { BoardValidationError } from "../boards/board-layout.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
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

export const boardStore = new SqliteBoardStore({
  resolveSession: ({ sessionKey, agentId }) => {
    const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
    const assertCurrent = () => {
      const current = captureGatewaySessionStoreScope(sessionKey, agentId);
      if (
        current.agentId !== scope.agentId ||
        current.storePath !== scope.storePath ||
        current.sessionKey !== scope.sessionKey
      ) {
        throw new BoardValidationError("invalid_operation", "board session changed; retry");
      }
    };
    const memory = captureSessionActorStorageOwner(scope, {
      assertCurrent,
      authorize: assertCurrent,
    });
    const database = memory ?? resolveSqliteTargetFromSessionStorePath(scope.storePath, scope);
    return {
      // Shared stores keep logical session keys under their persisted database owner.
      agentId: database.agentId ?? scope.agentId,
      path: database.path,
      sessionKey: scope.sessionKey,
      assertCurrent,
    };
  },
});
