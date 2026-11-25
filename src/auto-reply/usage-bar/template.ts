import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { watch, type WatchSubscription } from "@openclaw/fs-safe/watch";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord as isPlainObject } from "@openclaw/normalization-core/record-coerce";
import { createDedupeCache } from "../../infra/dedupe.js";
import { expandHomePrefix } from "../../infra/home-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { UsageBarTemplate } from "./translator.js";

function usageSegments() {
  return [
    { map: "model.is_fallback", cases: { true: "🔄" } },
    { map: "model.is_override", cases: { true: "📌" } },
    { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
    { map: "state.fast_mode", cases: { true: "⚡️", false: "🐌" } },
    {
      when: "context.max_tokens",
      text: "\u00A0| 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
    },
    { when: "cost.turn_usd", text: "\u00A0💰{cost.turn_usd|fixed:4}" },
  ];
}

const DEFAULT_USAGE_BAR_TEMPLATE: UsageBarTemplate = {
  schema: "openclaw.usageBar.v1",
  scales: {
    braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
    block: "░▏▎▍▌▋▊▉█",
    shade: "░▒▓█",
    moon: "🌑🌘🌗🌖🌕",
    level: "▁▂▃▄▅▆▇█",
    weather: ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
    plants: ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
    moons6: ["🌑", "🌚", "🌘", "🌗", "🌖", "🌝"],
  },
  aliases: {
    models: {
      "claude-opus-4-6": "opus46",
      "claude-opus-4-8": "opus48",
      "claude-sonnet-4-6": "sonnet46",
      "claude-haiku-4-5": "haiku45",
      "gpt-5.5": "gpt5.5",
    },
    reasoning: { off: "🌑", minimal: "🌚", low: "🌘", medium: "🌗", high: "🌕", xhigh: "🌝" },
  },
  output: {
    sep: "",
    default: [
      { text: "{model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
      ...usageSegments(),
    ],
    surfaces: {
      discord: [
        { text: "-# -\n" },
        { text: "-# {model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
        ...usageSegments(),
      ],
    },
  },
};

type UsageTemplateConfig = string | Record<string, unknown> | undefined;

type CacheEntry = {
  template: UsageBarTemplate | undefined;
  watcher?: Promise<WatchSubscription | undefined>;
  abort: AbortController;
};
const fileCache = new Map<string, CacheEntry>();
const MAX_CACHED_TEMPLATE_FILES = 64;
const MAX_WARNED_TEMPLATE_OVERRIDES = 256;
// Retain recent warning keys without accumulating every historical config value.
// LRU eviction intentionally allows old invalid overrides to warn again.
const warnedTemplateOverrides = createDedupeCache({
  maxSize: MAX_WARNED_TEMPLATE_OVERRIDES,
  ttlMs: 0,
});
const usageTemplateLog = createSubsystemLogger("usage-template");

function hasPieces(value: unknown): boolean {
  return Array.isArray(value) && value.some(isPlainObject);
}

function hasOutputPieces(output: unknown): boolean {
  if (!isPlainObject(output)) {
    return false;
  }
  if (hasPieces(output.default)) {
    return true;
  }
  const surfaces = output.surfaces;
  return isPlainObject(surfaces) && Object.values(surfaces).some(hasPieces);
}

type InvalidTemplateReason = "invalid-json" | "unreadable" | "unsupported-shape";
type TemplateReadResult = { template?: UsageBarTemplate; reason?: InvalidTemplateReason };

function resolveTemplateOrWarn(
  result: TemplateReadResult,
  source: "inline" | "file",
  path?: string,
): UsageBarTemplate | undefined {
  const reason = result.reason;
  if (reason && !warnedTemplateOverrides.check(`${source}:${reason}:${path ?? ""}`)) {
    usageTemplateLog.warn("configured usage template could not be used; using built-in footer", {
      source,
      reason,
      ...(path ? { path } : {}),
    });
  }
  return result.template;
}

function parseTemplate(value: unknown): TemplateReadResult {
  if (isPlainObject(value)) {
    const usable = hasOutputPieces(value.output) || hasPieces(value.segments);
    const surfaces = usable ? undefined : value.surfaces;
    if (
      usable ||
      (isPlainObject(surfaces) &&
        Object.values(surfaces).some(
          (surface) => isPlainObject(surface) && hasPieces(surface.segments),
        ))
    ) {
      return { template: value };
    }
    if (Object.keys(value).length === 0) {
      return {};
    }
    if (Array.isArray(value.segments)) {
      return value.segments.length === 0 ? {} : { reason: "unsupported-shape" };
    }
    const output = value.output;
    if (isPlainObject(output) && !hasOutputPieces(output)) {
      return {};
    }
  }
  return { reason: "unsupported-shape" };
}

function readTemplateFile(path: string): TemplateReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return extractErrorCode(error) === "ENOENT" ? {} : { reason: "unreadable" };
  }
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return parseTemplate(JSON.parse(raw));
  } catch {
    return { reason: "invalid-json" };
  }
}

function cacheTemplateFile(path: string): UsageBarTemplate | undefined {
  const template = resolveTemplateOrWarn(readTemplateFile(path), "file", path);
  // Evict before allocating a watcher, but preserve other entries on same-path retries.
  if (!fileCache.has(path) && fileCache.size >= MAX_CACHED_TEMPLATE_FILES) {
    const oldestKey = fileCache.keys().next().value;
    if (oldestKey !== undefined) {
      fileCache.get(oldestKey)?.abort.abort();
      fileCache.delete(oldestKey);
    }
  }
  const entry: CacheEntry = { template, abort: new AbortController() };
  if (entry.template) {
    entry.watcher = (async () => {
      // Preserve configured symlink targets, including links in parent directories.
      const canonical = await realpath(path);
      const authority = await root(dirname(canonical), { hardlinks: "allow" });
      if (entry.abort.signal.aborted) {
        return undefined;
      }
      const watcher = watch(authority, {
        mode: "auto",
        persistent: false,
        scopes: [{ path: basename(canonical), kind: "entry" }],
        signal: entry.abort.signal,
        onInvalidate: () => {
          const next = resolveTemplateOrWarn(readTemplateFile(path), "file", path);
          if (JSON.stringify(next) !== JSON.stringify(entry.template)) {
            entry.template = next;
          }
        },
        onHealth: (health) => {
          if (health.state === "unavailable") {
            entry.abort.abort();
            entry.watcher = undefined;
            entry.template = undefined;
          }
        },
      });
      await watcher.ready;
      return watcher;
    })().catch(() => {
      entry.abort.abort();
      entry.watcher = undefined;
      entry.template = undefined;
      return undefined;
    });
  }
  fileCache.set(path, entry);
  return entry.template;
}

export function loadUsageBarTemplate(configured: UsageTemplateConfig): UsageBarTemplate {
  if (!configured) {
    return DEFAULT_USAGE_BAR_TEMPLATE;
  }
  if (typeof configured === "object") {
    return resolveTemplateOrWarn(parseTemplate(configured), "inline") ?? DEFAULT_USAGE_BAR_TEMPLATE;
  }
  const path = configured.startsWith("~")
    ? resolve(expandHomePrefix(configured, { home: homedir() }))
    : resolve(configured);
  const cached = fileCache.get(path);
  return (
    cached?.template ??
    (cached?.watcher ? undefined : cacheTemplateFile(path)) ??
    DEFAULT_USAGE_BAR_TEMPLATE
  );
}

async function clearUsageBarTemplateCacheForTest(): Promise<void> {
  const entries = [...fileCache.values()];
  fileCache.clear();
  warnedTemplateOverrides.clear();
  for (const entry of entries) {
    entry.abort.abort();
  }
  await Promise.all(entries.map(async (entry) => (await entry.watcher)?.close()));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.usageBarTemplateTestApi")] = {
    clearUsageBarTemplateCacheForTest,
  };
}
