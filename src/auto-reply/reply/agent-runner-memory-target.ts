import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isUnscopedSessionKeySentinel } from "../../routing/session-key.js";
import type { FollowupRun } from "./queue.js";

/** Resolves the agent-scoped store that pre-turn compaction writes, from the session key. */
export function resolveSessionCompactionTarget(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionKey: string;
  storePath?: string;
  sessionStore?: Record<string, SessionEntry>;
  entry: SessionEntry;
}) {
  const { cfg, sessionKey } = params;
  const configuredAgentId = params.followupRun.run.agentId ?? resolveDefaultAgentId(cfg);
  const agentId = isUnscopedSessionKeySentinel(sessionKey)
    ? configuredAgentId
    : resolveAgentIdFromSessionKey(sessionKey, configuredAgentId);
  const storePath = resolveSessionStorePathForScope({
    agentId,
    sessionKey,
    storePath: params.storePath ?? resolveSessionStorePathCore(cfg.session?.store, { agentId }),
  });
  return {
    compactionStore: params.sessionStore ?? { [sessionKey]: params.entry },
    compactionTarget: { agentId, sessionKey, storePath },
  };
}
