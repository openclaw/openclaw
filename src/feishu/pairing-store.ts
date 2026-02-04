import type { OpenClawConfig } from "../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";

export type FeishuPairingListEntry = {
  openId: string;
  unionId?: string;
  name?: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
};

const PROVIDER = "feishu" as const;

export async function readFeishuAllowFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readChannelAllowFromStore(PROVIDER, env);
}

export async function addFeishuAllowFromStoreEntry(params: {
  entry: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return addChannelAllowFromStoreEntry({
    channel: PROVIDER,
    entry: params.entry,
    env: params.env,
  });
}

export async function listFeishuPairingRequests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeishuPairingListEntry[]> {
  const list = await listChannelPairingRequests(PROVIDER, env);
  return list.map((r) => ({
    openId: r.id,
    code: r.code,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    unionId: r.meta?.unionId,
    name: r.meta?.name,
  }));
}

export async function upsertFeishuPairingRequest(params: {
  openId: string;
  unionId?: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  return upsertChannelPairingRequest({
    channel: PROVIDER,
    id: params.openId,
    env: params.env,
    meta: {
      unionId: params.unionId,
      name: params.name,
    },
  });
}

export async function approveFeishuPairingCode(params: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ openId: string; entry?: FeishuPairingListEntry } | null> {
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
        openId: res.entry.id,
        code: res.entry.code,
        createdAt: res.entry.createdAt,
        lastSeenAt: res.entry.lastSeenAt,
        unionId: res.entry.meta?.unionId,
        name: res.entry.meta?.name,
      }
    : undefined;
  return { openId: res.id, entry };
}

export async function resolveFeishuEffectiveAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ dm: string[]; group: string[] }> {
  const env = params.env ?? process.env;
  const feishuCfg = params.cfg.channels?.feishu;
  const accountCfg = params.accountId ? feishuCfg?.accounts?.[params.accountId] : undefined;

  // Account-level config takes precedence over top-level
  const allowFrom = accountCfg?.allowFrom ?? feishuCfg?.allowFrom ?? [];
  const groupAllowFrom = accountCfg?.groupAllowFrom ?? feishuCfg?.groupAllowFrom ?? [];

  const cfgAllowFrom = allowFrom
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^feishu:/i, ""))
    .filter((v) => v !== "*");

  const cfgGroupAllowFrom = groupAllowFrom
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^feishu:/i, ""))
    .filter((v) => v !== "*");

  const storeAllowFrom = await readFeishuAllowFromStore(env);

  const dm = Array.from(new Set([...cfgAllowFrom, ...storeAllowFrom]));
  const group = Array.from(
    new Set([
      ...(cfgGroupAllowFrom.length > 0 ? cfgGroupAllowFrom : cfgAllowFrom),
      ...storeAllowFrom,
    ]),
  );
  return { dm, group };
}
