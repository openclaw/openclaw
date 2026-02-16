import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export type VoiceWakeRouteTarget =
  | { mode: "current"; agentId?: undefined; sessionKey?: undefined }
  | { agentId: string; sessionKey?: undefined; mode?: undefined }
  | { sessionKey: string; agentId?: undefined; mode?: undefined };

export type VoiceWakeRouteRule = {
  trigger: string;
  target: VoiceWakeRouteTarget;
};

export type VoiceWakeRoutingConfig = {
  version: 1;
  defaultTarget: VoiceWakeRouteTarget;
  routes: VoiceWakeRouteRule[];
  updatedAtMs: number;
};

const DEFAULT_ROUTING: VoiceWakeRoutingConfig = {
  version: 1,
  defaultTarget: { mode: "current" },
  routes: [],
  updatedAtMs: 0,
};

function resolvePath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake-routing.json");
}

export function normalizeVoiceWakeTriggerWord(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRouteTarget(value: unknown): VoiceWakeRouteTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as { mode?: unknown; agentId?: unknown; sessionKey?: unknown };
  const mode = normalizeOptionalString(rec.mode);
  if (mode === "current") {
    return { mode: "current" };
  }
  const agentId = normalizeOptionalString(rec.agentId);
  const sessionKey = normalizeOptionalString(rec.sessionKey);
  if (agentId && !sessionKey) {
    return { agentId };
  }
  if (sessionKey && !agentId) {
    return { sessionKey };
  }
  return null;
}

function normalizeRouteRule(value: unknown): VoiceWakeRouteRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as { trigger?: unknown; target?: unknown };
  const triggerRaw = normalizeOptionalString(rec.trigger);
  if (!triggerRaw) {
    return null;
  }
  const trigger = normalizeVoiceWakeTriggerWord(triggerRaw);
  if (!trigger) {
    return null;
  }
  const target = normalizeRouteTarget(rec.target);
  if (!target) {
    return null;
  }
  return { trigger, target };
}

export function normalizeVoiceWakeRoutingConfig(input: unknown): VoiceWakeRoutingConfig {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_ROUTING };
  }
  const rec = input as {
    version?: unknown;
    defaultTarget?: unknown;
    routes?: unknown;
    updatedAtMs?: unknown;
  };
  const defaultTarget = normalizeRouteTarget(rec.defaultTarget) ?? { mode: "current" as const };
  const routes = Array.isArray(rec.routes)
    ? rec.routes
        .map((entry) => normalizeRouteRule(entry))
        .filter((entry): entry is VoiceWakeRouteRule => Boolean(entry))
    : [];
  const updatedAtMs =
    typeof rec.updatedAtMs === "number" && Number.isFinite(rec.updatedAtMs) && rec.updatedAtMs > 0
      ? Math.floor(rec.updatedAtMs)
      : 0;
  return {
    version: 1,
    defaultTarget,
    routes,
    updatedAtMs,
  };
}

const withLock = createAsyncLock();

export async function loadVoiceWakeRoutingConfig(
  baseDir?: string,
): Promise<VoiceWakeRoutingConfig> {
  const filePath = resolvePath(baseDir);
  const existing = await readJsonFile<unknown>(filePath);
  if (!existing) {
    return { ...DEFAULT_ROUTING };
  }
  return normalizeVoiceWakeRoutingConfig(existing);
}

export async function setVoiceWakeRoutingConfig(
  config: unknown,
  baseDir?: string,
): Promise<VoiceWakeRoutingConfig> {
  const normalized = normalizeVoiceWakeRoutingConfig(config);
  const filePath = resolvePath(baseDir);
  return await withLock(async () => {
    const next: VoiceWakeRoutingConfig = {
      ...normalized,
      updatedAtMs: Date.now(),
    };
    await writeJsonAtomic(filePath, next);
    return next;
  });
}

export type VoiceWakeResolvedRoute =
  | { mode: "current" }
  | { agentId: string }
  | { sessionKey: string };

export function resolveVoiceWakeRouteTarget(
  routeTarget: VoiceWakeRouteTarget | undefined,
): VoiceWakeResolvedRoute {
  if (!routeTarget || ("mode" in routeTarget && routeTarget.mode === "current")) {
    return { mode: "current" };
  }
  if ("agentId" in routeTarget && routeTarget.agentId) {
    return { agentId: routeTarget.agentId };
  }
  if ("sessionKey" in routeTarget && routeTarget.sessionKey) {
    return { sessionKey: routeTarget.sessionKey };
  }
  return { mode: "current" };
}

export function resolveVoiceWakeRouteByTrigger(params: {
  trigger: string | undefined;
  config: VoiceWakeRoutingConfig;
}): VoiceWakeResolvedRoute {
  const normalizedTrigger = normalizeOptionalString(params.trigger)
    ? normalizeVoiceWakeTriggerWord(params.trigger as string)
    : "";
  if (normalizedTrigger) {
    const matched = params.config.routes.find((route) => route.trigger === normalizedTrigger);
    if (matched) {
      return resolveVoiceWakeRouteTarget(matched.target);
    }
  }
  return resolveVoiceWakeRouteTarget(params.config.defaultTarget);
}
