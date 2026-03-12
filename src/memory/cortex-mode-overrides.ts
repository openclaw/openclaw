import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { CortexPolicy } from "./cortex.js";

export type CortexModeScope = "session" | "channel";

export type CortexModeOverride = {
  agentId: string;
  scope: CortexModeScope;
  targetId: string;
  mode: CortexPolicy;
  updatedAt: string;
};

type CortexModeOverrideStore = {
  session: Record<string, CortexModeOverride>;
  channel: Record<string, CortexModeOverride>;
};

function buildKey(agentId: string, targetId: string): string {
  return `${agentId}:${targetId}`;
}

export function resolveCortexModeOverridesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "cortex-mode-overrides.json");
}

async function readStore(
  pathname = resolveCortexModeOverridesPath(),
): Promise<CortexModeOverrideStore> {
  try {
    const raw = await fs.readFile(pathname, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CortexModeOverrideStore>;
    return {
      session: parsed.session ?? {},
      channel: parsed.channel ?? {},
    };
  } catch {
    return {
      session: {},
      channel: {},
    };
  }
}

async function writeStore(
  store: CortexModeOverrideStore,
  pathname = resolveCortexModeOverridesPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, JSON.stringify(store, null, 2));
}

export async function getCortexModeOverride(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
  pathname?: string;
}): Promise<CortexModeOverride | null> {
  const store = await readStore(params.pathname);
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    const session = store.session[buildKey(params.agentId, sessionId)];
    if (session) {
      return session;
    }
  }
  const channelId = params.channelId?.trim();
  if (channelId) {
    const channel = store.channel[buildKey(params.agentId, channelId)];
    if (channel) {
      return channel;
    }
  }
  return null;
}

export async function setCortexModeOverride(params: {
  agentId: string;
  scope: CortexModeScope;
  targetId: string;
  mode: CortexPolicy;
  pathname?: string;
}): Promise<CortexModeOverride> {
  const store = await readStore(params.pathname);
  const next: CortexModeOverride = {
    agentId: params.agentId,
    scope: params.scope,
    targetId: params.targetId,
    mode: params.mode,
    updatedAt: new Date().toISOString(),
  };
  store[params.scope][buildKey(params.agentId, params.targetId)] = next;
  await writeStore(store, params.pathname);
  return next;
}

export async function clearCortexModeOverride(params: {
  agentId: string;
  scope: CortexModeScope;
  targetId: string;
  pathname?: string;
}): Promise<boolean> {
  const store = await readStore(params.pathname);
  const key = buildKey(params.agentId, params.targetId);
  if (!store[params.scope][key]) {
    return false;
  }
  delete store[params.scope][key];
  await writeStore(store, params.pathname);
  return true;
}
