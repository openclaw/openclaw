import { type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import type { UsageBarTemplate } from "./translator.js";

export type UsageTemplateConfig = string | Record<string, unknown> | undefined;

/** Sentinel value of `messages.usageTemplate` that selects the built-in default. */
const DEFAULT_SENTINEL = "default";

type CacheEntry = { template: UsageBarTemplate | undefined; watcher?: FSWatcher };
const fileCache = new Map<string, CacheEntry>();

function expandPath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(p);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge a user override OVER the built-in default, like other openclaw
 * config objects: nested objects are merged key-by-key (so `scales`/`aliases`
 * extend rather than replace), while arrays and scalars from the override win
 * (a `output.surfaces.<channel>` piece-list replaces that channel's default).
 * Never mutates `base` — each level is cloned.
 */
function mergeTemplate(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): UsageBarTemplate {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    out[key] =
      isPlainObject(prev) && isPlainObject(value) ? mergeTemplate(prev, value) : value;
  }
  return out;
}

function readTemplateFile(path: string): UsageBarTemplate | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cacheTemplateFile(path: string): UsageBarTemplate | undefined {
  const entry: CacheEntry = { template: readTemplateFile(path) };
  if (entry.template) {
    try {
      const watcher = watch(path, { persistent: false }, () => {
        entry.template = readTemplateFile(path);
      });
      watcher.on("error", () => {
        watcher.close();
      });
      entry.watcher = watcher;
    } catch {
      // Cache remains valid without live refresh.
    }
  }
  fileCache.set(path, entry);
  return entry.template;
}

export function loadUsageBarTemplate(
  configured: UsageTemplateConfig,
): UsageBarTemplate | undefined {
  if (!configured) {
    return undefined;
  }
  // The bare default, no override.
  if (configured === DEFAULT_SENTINEL) {
    return DEFAULT_USAGE_BAR_TEMPLATE;
  }
  // Inline override object → merged over the default.
  if (typeof configured === "object") {
    return isPlainObject(configured)
      ? mergeTemplate(DEFAULT_USAGE_BAR_TEMPLATE, configured)
      : undefined;
  }
  // File path → parsed override merged over the default. A missing/invalid file
  // yields no override (undefined), so the caller falls back to the built-in line.
  const path = expandPath(configured);
  const cached = fileCache.get(path);
  const override = cached
    ? (cached.template ?? (cached.watcher ? undefined : cacheTemplateFile(path)))
    : cacheTemplateFile(path);
  return override ? mergeTemplate(DEFAULT_USAGE_BAR_TEMPLATE, override) : undefined;
}

export function clearUsageBarTemplateCacheForTest(): void {
  for (const entry of fileCache.values()) {
    entry.watcher?.close();
  }
  fileCache.clear();
}
