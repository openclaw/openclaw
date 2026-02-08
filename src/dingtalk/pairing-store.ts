import type { OpenClawConfig } from "../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";

const PROVIDER = "dingtalk" as const;

export type DingTalkPairingListEntry = {
  userId: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  name?: string;
};

export async function readDingTalkAllowFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readChannelAllowFromStore(PROVIDER, env);
}

export async function addDingTalkAllowFromStoreEntry(params: {
  entry: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return addChannelAllowFromStoreEntry({
    channel: PROVIDER,
    entry: params.entry,
    env: params.env,
  });
}

export async function listDingTalkPairingRequests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DingTalkPairingListEntry[]> {
  const list = await listChannelPairingRequests(PROVIDER, env);
  return list.map((r) => ({
    userId: r.id,
    code: r.code,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    name: r.meta?.name,
  }));
}

export async function upsertDingTalkPairingRequest(params: {
  userId: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  return upsertChannelPairingRequest({
    channel: PROVIDER,
    id: params.userId,
    env: params.env,
    meta: { name: params.name },
  });
}

export async function approveDingTalkPairingCode(params: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ userId: string; entry?: DingTalkPairingListEntry } | null> {
  const res = await approveChannelPairingCode({
    channel: PROVIDER,
    code: params.code,
    env: params.env,
  });
  if (!res) {
    return null;
  }
  const entry = res.entry
    ? {
        userId: res.entry.id,
        code: res.entry.code,
        createdAt: res.entry.createdAt,
        lastSeenAt: res.entry.lastSeenAt,
        name: res.entry.meta?.name,
      }
    : undefined;
  return { userId: res.id, entry };
}

export async function resolveDingTalkEffectiveAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ dm: string[]; group: string[] }> {
  const env = params.env ?? process.env;
  const dtCfg = params.cfg.channels?.dingtalk;
  const accountCfg = params.accountId ? dtCfg?.accounts?.[params.accountId] : undefined;
  const allowFrom = accountCfg?.allowFrom ?? dtCfg?.allowFrom ?? [];
  const groupAllowFrom = accountCfg?.groupAllowFrom ?? dtCfg?.groupAllowFrom ?? [];

  const cfgAllowFrom = allowFrom
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^dingtalk:/i, ""))
    .filter((v) => v !== "*");
  const cfgGroupAllowFrom = groupAllowFrom
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^dingtalk:/i, ""))
    .filter((v) => v !== "*");
  const storeAllowFrom = await readDingTalkAllowFromStore(env);

  const dm = Array.from(new Set([...cfgAllowFrom, ...storeAllowFrom]));
  const group = Array.from(
    new Set([
      ...(cfgGroupAllowFrom.length > 0 ? cfgGroupAllowFrom : cfgAllowFrom),
      ...storeAllowFrom,
    ]),
  );
  return { dm, group };
}
