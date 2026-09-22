import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
  type SessionStorePathScope,
} from "./paths.js";

export function resolveSessionStorePathForScope(
  scope: SessionStorePathScope,
  config?: OpenClawConfig,
): string {
  const explicitStorePath = resolveExplicitSessionStorePathForScope(scope);
  if (explicitStorePath) {
    return explicitStorePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveSessionStorePathCore((config ?? getRuntimeConfig()).session?.store, {
    agentId,
    env: scope.env,
  });
}
