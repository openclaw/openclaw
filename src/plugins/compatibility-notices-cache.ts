import { createHash } from "node:crypto";
import syncFs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { PluginCompatibilityNotice } from "./compatibility-notice-types.js";
import { normalizePluginsConfig } from "./config-state.js";

// Bump when the cache key shape changes so pre-existing files miss cleanly.
const CACHE_ENVELOPE_VERSION = 2;
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

function isValidNotice(value: unknown): value is PluginCompatibilityNotice {
  if (!value || typeof value !== "object") {
    return false;
  }
  const notice = value as Partial<PluginCompatibilityNotice>;
  return (
    typeof notice.pluginId === "string" &&
    (notice.code === "legacy-before-agent-start" || notice.code === "hook-only") &&
    (notice.severity === "warn" || notice.severity === "info") &&
    typeof notice.message === "string"
  );
}

export function resolveCompatibilityNoticesCacheKey(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const rawConfig = params.config ?? ({} as OpenClawConfig);
  const normalizedPlugins = normalizePluginsConfig(rawConfig.plugins);
  // Plugin auto-enable reads from channels/auth/models/tools/agents beyond
  // `plugins`. Hash the full non-plugins config so any input that can change the
  // active plugin set invalidates the cache, and keep normalized `plugins`
  // separately so plugin-id aliases still collapse to the same key.
  const { plugins: _omitPlugins, ...restConfig } = rawConfig as {
    plugins?: unknown;
  } & Record<string, unknown>;
  const payload = stableStringify({
    v: CACHE_ENVELOPE_VERSION,
    openclaw: resolveCompatibilityHostVersion(env),
    plugins: normalizedPlugins,
    rest: restConfig,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveCompatibilityNoticesCacheWorkspaceDir(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  if (params.workspaceDir) {
    return params.workspaceDir;
  }
  const config = params.config ?? ({} as OpenClawConfig);
  return resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
}

export function resolveCompatibilityNoticesCachePath(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const dir = resolveCompatibilityNoticesCacheWorkspaceDir(params);
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
      Array.isArray(parsed.notices) &&
      parsed.notices.every(isValidNotice)
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
