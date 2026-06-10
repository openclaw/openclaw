import type { SessionEntry } from "../../src/config/sessions/types.js";

export const HUB_OWNER_A = "agent:main:webchat:main";

export function delegateSessionKey(harness = "codex", suffix = "worker"): string {
  return `agent:${harness}:acp:${suffix}`;
}

export function hubDelegatedEntry(params?: {
  sessionId?: string;
  ownerSessionKey?: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
  spawnedBy?: string;
  parentSessionKey?: string;
  acp?: SessionEntry["acp"];
}): SessionEntry {
  const owner = params?.ownerSessionKey ?? HUB_OWNER_A;
  const createdAt = params?.createdAt ?? 1;
  const updatedAt = params?.updatedAt ?? createdAt;
  return {
    sessionId: params?.sessionId ?? "sess-delegate",
    updatedAt,
    ...(params?.label ? { label: params.label } : {}),
    spawnedBy: params?.spawnedBy ?? owner,
    parentSessionKey: params?.parentSessionKey ?? owner,
    hubDelegated: { ownerSessionKey: owner, createdAt },
    ...(params?.acp ? { acp: params.acp } : {}),
  };
}
