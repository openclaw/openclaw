import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import {
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";

export function resolveAbortSessionKey(params: {
  sources: Iterable<readonly [string, RpcSourceRef]>;
  requestedKey: string;
  canonicalKey: string;
  activeRunSessionKey?: string;
  aliasKeys?: string[];
  agentId?: string;
  defaultAgentId?: string;
}): string {
  if (params.activeRunSessionKey) {
    return params.activeRunSessionKey;
  }
  const candidates = new Set([
    params.canonicalKey,
    params.requestedKey,
    ...(params.aliasKeys ?? []),
  ]);
  for (const [, active] of params.sources) {
    if (active.adapter.controlUiVisible === false) {
      continue;
    }
    const identity = getRpcSourceIdentity(active);
    if (candidates.has(identity.sessionKey)) {
      const owner = resolveChatRunOwnerAgentId({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        defaultAgentId: params.defaultAgentId,
      });
      if (!params.agentId || owner === normalizeAgentId(params.agentId)) {
        return identity.sessionKey;
      }
    }
  }
  return params.aliasKeys?.[0] ?? params.requestedKey;
}

export function resolveSessionKeyAgentId(
  sessionKey: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  return parsed?.agentId ?? tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
}

export function sessionKeyBelongsToAgent(
  sessionKey: string | undefined,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  return resolveSessionKeyAgentId(sessionKey, cfg) === normalizeAgentId(agentId);
}

export function resolveScopedAbortKey(params: {
  cfg: OpenClawConfig;
  key: string | undefined;
  agentId: string | undefined;
}): string | undefined {
  const key = normalizeOptionalString(params.key);
  if (!key) {
    return undefined;
  }
  const requestedAgentId = normalizeOptionalString(params.agentId);
  if (!requestedAgentId) {
    return key;
  }
  const scopedAgentId = normalizeAgentId(requestedAgentId);
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  if (ownerAgentId && ownerAgentId !== scopedAgentId) {
    return undefined;
  }
  return resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
}
