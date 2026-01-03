import { resolveToolDisplay, formatToolSummary } from "../agents/tool-display.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";

export const TOOL_RESULT_DEBOUNCE_MS = 500;
export const TOOL_RESULT_FLUSH_COUNT = 5;

export function shortenPath(p: string): string {
  return shortenHomePath(p);
}

export function shortenMeta(meta: string): string {
  if (!meta) return meta;
  const colonIdx = meta.indexOf(":");
  if (colonIdx === -1) return shortenHomeInString(meta);
  const base = meta.slice(0, colonIdx);
  const rest = meta.slice(colonIdx);
  return `${shortenHomeInString(base)}${rest}`;
}

export function formatToolAggregate(
  toolName?: string,
  metas?: string[],
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenMeta);
  const display = resolveToolDisplay({ name: toolName });
  const prefix = `${display.emoji} ${display.label}`;
  if (!filtered.length) return prefix;

  const rawSegments: string[] = [];
  // Group by directory and brace-collapse filenames
  const grouped: Record<string, string[]> = {};
  for (const m of filtered) {
    if (!isPathLike(m)) {
      rawSegments.push(m);
      continue;
    }
    if (m.includes("→")) {
      rawSegments.push(m);
      continue;
    }
    const parts = m.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      const base = parts.at(-1) ?? m;
      if (!grouped[dir]) grouped[dir] = [];
      grouped[dir].push(base);
    } else {
      if (!grouped["."]) grouped["."] = [];
      grouped["."].push(m);
    }
  }

  const segments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    if (dir === ".") return brace;
    return `${dir}/${brace}`;
  });

  const allSegments = [...rawSegments, ...segments];
  return `${prefix}: ${allSegments.join("; ")}`;
}

export function formatToolPrefix(toolName?: string, meta?: string) {
  const extra = meta?.trim() ? shortenMeta(meta) : undefined;
  const display = resolveToolDisplay({ name: toolName, meta: extra });
  return formatToolSummary(display);
}

function isPathLike(value: string): boolean {
  if (!value) return false;
  if (value.includes(" ")) return false;
  if (value.includes("://")) return false;
  if (value.includes("·")) return false;
  if (value.includes("&&") || value.includes("||")) return false;
  return /^~?(\\/[^\\s]+)+$/.test(value);
}

export function createToolDebouncer(
  onFlush: (toolName: string | undefined, metas: string[]) => void,
  windowMs = TOOL_RESULT_DEBOUNCE_MS,
) {
  let pendingTool: string | undefined;
  let pendingMetas: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (!pendingTool && pendingMetas.length === 0) return;
    onFlush(pendingTool, pendingMetas);
    pendingTool = undefined;
    pendingMetas = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const push = (toolName?: string, meta?: string) => {
    if (pendingTool && toolName && pendingTool !== toolName) flush();
    if (!pendingTool) pendingTool = toolName;
    if (meta) pendingMetas.push(meta);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, windowMs);
  };

  return { push, flush };
}
