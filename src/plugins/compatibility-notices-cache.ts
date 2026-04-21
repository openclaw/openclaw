import { createHash } from "node:crypto";
import syncFs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { PluginCompatibilityNotice } from "./compatibility-notice-types.js";
import { normalizePluginsConfig } from "./config-state.js";

const CACHE_ENVELOPE_VERSION = 1;
const CACHE_DIRNAME = ".openclaw";
const CACHE_FILENAME = "plugin-compat-cache.json";

type CacheEnvelope = {
  version: number;
  key: string;
  notices: PluginCompatibilityNotice[];
};

function isCacheEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const flag = (env ?? process.env).OPENCLAW_COMPAT_CACHE;
  return flag !== "0" && flag !== "false";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",");
  return `{${body}}`;
}

export function resolveCompatibilityNoticesCacheKey(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const plugins = normalizePluginsConfig(params.config?.plugins);
  const payload = stableStringify({
    v: CACHE_ENVELOPE_VERSION,
    openclaw: resolveCompatibilityHostVersion(env),
    plugins,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveCompatibilityNoticesCachePath(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const dir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir(params.env);
  return path.join(dir, CACHE_DIRNAME, CACHE_FILENAME);
}

export function readCompatibilityNoticesCache(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): PluginCompatibilityNotice[] | null {
  const env = params.env ?? process.env;
  if (!isCacheEnabled(env)) {
    return null;
  }
  const filePath = resolveCompatibilityNoticesCachePath(params);
  let raw: string;
  try {
    raw = syncFs.readFileSync(filePath, { encoding: "utf-8" });
  } catch {
    return null;
  }
  let envelope: CacheEnvelope | null = null;
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === CACHE_ENVELOPE_VERSION &&
      typeof parsed.key === "string" &&
      Array.isArray(parsed.notices)
    ) {
      envelope = parsed;
    }
  } catch {
    return null;
  }
  if (!envelope) {
    return null;
  }
  const key = resolveCompatibilityNoticesCacheKey({ config: params.config, env });
  if (envelope.key !== key) {
    return null;
  }
  return envelope.notices;
}

export function writeCompatibilityNoticesCache(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  notices: PluginCompatibilityNotice[];
}): void {
  const env = params.env ?? process.env;
  if (!isCacheEnabled(env)) {
    return;
  }
  const filePath = resolveCompatibilityNoticesCachePath(params);
  const key = resolveCompatibilityNoticesCacheKey({ config: params.config, env });
  const envelope: CacheEnvelope = {
    version: CACHE_ENVELOPE_VERSION,
    key,
    notices: params.notices,
  };
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    syncFs.mkdirSync(path.dirname(filePath), { recursive: true });
    syncFs.writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf-8",
    });
    syncFs.renameSync(tmpPath, filePath);
  } catch {
    try {
      syncFs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }
}
