// Resolve the usage-bar template from config (`messages.usageTemplate`): either
// an inline template object, or a path to a JSON file. For a path, the template
// is read ONCE into memory and then kept fresh by a filesystem watcher, so the
// per-reply render path never touches disk — no synchronous stat/read in the
// latency-sensitive reply-delivery path. When no usable template resolves, the
// caller falls back to the built-in (boring) usage line.
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { UsageBarTemplate } from "./translator.js";

export type UsageTemplateConfig = string | Record<string, unknown> | undefined;

type CacheEntry = { template: UsageBarTemplate | undefined; watcher?: FSWatcher };
// Keyed by resolved path. A present entry means the file was read at least once;
// the reply path then serves `template` synchronously with zero filesystem
// access, and a watcher refreshes it off the hot path on change.
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

// A usable template must carry a layout the engine understands.
function isUsableTemplate(value: unknown): value is UsageBarTemplate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasOutput = typeof obj.output === "object" && obj.output !== null;
  return hasOutput || Array.isArray(obj.segments);
}

// Read + parse a template file into a usable template, or undefined for
// unreadable/invalid contents. Only called off the reply path: at first load and
// from the watcher callback.
function readTemplateFile(path: string): UsageBarTemplate | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // removed/unreadable -> boring fallback
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUsableTemplate(parsed) ? parsed : undefined;
  } catch {
    return undefined; // invalid JSON -> boring fallback
  }
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
  const path = expandPath(configured);
  const cached = fileCache.get(path);
  if (cached) {
    return cached.template; // hot path: in-memory, no filesystem access
  }
  // First resolution for this path. Probe once; if the file is missing/unreadable
  // we do NOT cache, so a later-created template is still picked up on a
  // subsequent call (the only path that stats per reply is the misconfigured
  // "configured but absent" one, never the normal one).
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let template: UsageBarTemplate | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    template = isUsableTemplate(parsed) ? parsed : undefined;
  } catch {
    template = undefined;
  }
  // The file exists and was read once; from here the reply path is filesystem
  // free. Keep the in-memory copy fresh via a watcher (off the hot path). A watch
  // failure (unsupported FS, race) just leaves the one-time load with no live
  // refresh — still strictly better than a stat on every reply.
  const entry: CacheEntry = { template };
  try {
    const watcher = watch(path, { persistent: false }, () => {
      entry.template = readTemplateFile(path);
    });
    watcher.on("error", () => {
      // Best-effort: keep the last-known template rather than throwing on a
      // watch error (e.g. the file being removed).
    });
    entry.watcher = watcher;
  } catch {
    // Unwatchable path: cache the one-time load anyway (no refresh until restart).
  }
  fileCache.set(path, entry);
  return template;
}

export function clearUsageBarTemplateCacheForTest(): void {
  for (const entry of fileCache.values()) {
    entry.watcher?.close();
  }
  fileCache.clear();
}
