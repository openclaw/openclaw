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

function isUsableTemplate(value: unknown): value is UsageBarTemplate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasOutput = typeof obj.output === "object" && obj.output !== null;
  return hasOutput || Array.isArray(obj.segments);
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
    return isUsableTemplate(parsed) ? parsed : undefined;
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
  if (typeof configured === "object") {
    return isUsableTemplate(configured) ? configured : undefined;
  }
  if (configured === DEFAULT_SENTINEL) {
    return DEFAULT_USAGE_BAR_TEMPLATE;
  }
  const path = expandPath(configured);
  const cached = fileCache.get(path);
  if (cached) {
    return cached.template ?? (cached.watcher ? undefined : cacheTemplateFile(path));
  }
  return cacheTemplateFile(path);
}

export function clearUsageBarTemplateCacheForTest(): void {
  for (const entry of fileCache.values()) {
    entry.watcher?.close();
  }
  fileCache.clear();
}
