import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { getRuntimeConfig } from "../io.js";
import { lookupIncognitoSessionAgentId } from "./incognito-session-registry.js";
import { resolveStorePath } from "./paths.js";

type SessionStorePathScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
};

export function resolveSessionStorePathForScope(scope: SessionStorePathScope): string {
  const incognitoAgentId = scope.sessionKey
    ? lookupIncognitoSessionAgentId(scope.sessionKey)
    : undefined;
  if (incognitoAgentId) {
    return resolveIncognitoOpenClawAgentSqlitePath({
      agentId: incognitoAgentId,
      env: scope.env,
    });
  }
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: scope.env,
  });
}
