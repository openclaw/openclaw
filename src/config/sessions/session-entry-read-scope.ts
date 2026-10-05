import path from "node:path";
import {
  isIncognitoSessionKey,
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";

export function captureSessionEntryReadScope(input: SessionEntryReadScope) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = {
    ...input,
    env,
    ...(input.storePath ? { storePath: path.resolve(input.storePath) } : {}),
  };
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : parseAgentSessionKey(scope.sessionKey)?.agentId;
  return { scope, env, agentId };
}

export function isNativeSessionEntryRead(
  scope: SessionEntryReadScope,
  agentId: string | undefined,
) {
  const storePath = scope.storePath;
  return Boolean(
    isIncognitoSessionKey(scope.sessionKey) ||
    (storePath &&
      (isIncognitoOpenClawAgentSqlitePath(storePath, {
        agentId: agentId ?? scope.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
        env: scope.env,
      }) ||
        listOpenIncognitoAgentDatabases().some((owner) => owner.storePath === storePath))),
  );
}
