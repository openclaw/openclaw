// Resolve the usage-bar template from config (`messages.usageTemplate`): either
// an inline template object, or a path to a JSON file. File reads are cached by
// mtime so the per-reply render path does not hit disk every time, while still
// picking up edits to the template. When no usable template resolves, the
// caller falls back to the built-in (boring) usage line.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { UsageBarTemplate } from "./translator.js";

export type UsageTemplateConfig = string | Record<string, unknown> | undefined;

const fileCache = new Map<string, { mtimeMs: number; template: UsageBarTemplate | undefined }>();

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
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined; // missing/unreadable -> boring fallback
  }
  const cached = fileCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.template;
  }
  let template: UsageBarTemplate | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    template = isUsableTemplate(parsed) ? parsed : undefined;
  } catch {
    template = undefined;
  }
  fileCache.set(path, { mtimeMs, template });
  return template;
}

export function clearUsageBarTemplateCacheForTest(): void {
  fileCache.clear();
}
