import fs from "node:fs";
import path from "node:path";
import { writeSessionStoreForTest } from "../../src/config/sessions/test-helpers.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";

export const HUB_OWNER_A = "agent:main:webchat:main";
export const HUB_OWNER_B = "agent:main:discord:other";
export const HUB_OWNER_MAIN = "agent:main:main";

export function hubDelegatedMarker(
  ownerSessionKey: string,
  createdAt = 1,
): NonNullable<SessionEntry["hubDelegated"]> {
  return { ownerSessionKey, createdAt };
}

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
    hubDelegated: hubDelegatedMarker(owner, createdAt),
    ...(params?.acp ? { acp: params.acp } : {}),
  };
}

export function hubDelegatedStoreRow(
  sessionKey: string,
  entry: SessionEntry,
): Record<string, SessionEntry> {
  return { [sessionKey]: entry };
}

export function writeDelegateStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  writeSessionStoreForTest(storePath, { [sessionKey]: entry });
}
