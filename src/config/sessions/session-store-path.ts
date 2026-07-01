import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";

type SessionStorePathScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
};

export function resolveSessionStorePathForScope(scope: SessionStorePathScope): string {
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: scope.env,
  });
}
