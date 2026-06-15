import type { PluginHookExternalContentProvenance } from "../plugins/types.js";

type ToolHookExternalContentSource = PluginHookExternalContentProvenance["sources"][number];

const EXTERNAL_CONTENT_MARKER = "<<<EXTERNAL_UNTRUSTED_CONTENT";
const EXTERNAL_CONTENT_SOURCE_ORDER: ToolHookExternalContentSource[] = [
  "email",
  "webhook",
  "api",
  "browser",
  "channel_metadata",
  "web_search",
  "web_fetch",
  "unknown",
];

const EXTERNAL_CONTENT_SOURCE_BY_LABEL = new Map<string, ToolHookExternalContentSource>([
  ["email", "email"],
  ["webhook", "webhook"],
  ["api", "api"],
  ["browser", "browser"],
  ["channel metadata", "channel_metadata"],
  ["web search", "web_search"],
  ["web fetch", "web_fetch"],
  ["external", "unknown"],
]);

function collectToolHookExternalContentSources(
  value: unknown,
  sources: Set<ToolHookExternalContentSource>,
  seen = new Set<unknown>(),
  depth = 0,
): void {
  if (value === null || value === undefined || depth > 8) {
    return;
  }

  if (typeof value === "string") {
    if (!value.includes(EXTERNAL_CONTENT_MARKER)) {
      return;
    }
    sources.add("unknown");
    for (const match of value.matchAll(/^Source:\s*([^\r\n]+)/gim)) {
      const source = EXTERNAL_CONTENT_SOURCE_BY_LABEL.get(match[1]?.trim().toLowerCase() ?? "");
      if (source) {
        sources.add(source);
      }
    }
    if (sources.size > 1) {
      sources.delete("unknown");
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolHookExternalContentSources(item, sources, seen, depth + 1);
    }
    return;
  }

  for (const item of Object.values(value as Record<string, unknown>)) {
    collectToolHookExternalContentSources(item, sources, seen, depth + 1);
  }
}

export function detectToolHookExternalContentProvenance(
  values: readonly unknown[],
): PluginHookExternalContentProvenance | undefined {
  const sources = new Set<ToolHookExternalContentSource>();
  for (const value of values) {
    collectToolHookExternalContentSources(value, sources);
  }
  if (sources.size === 0) {
    return undefined;
  }
  return {
    present: true,
    sources: EXTERNAL_CONTENT_SOURCE_ORDER.filter((source) => sources.has(source)),
  };
}

export function mergeToolHookExternalContentProvenance(
  left: PluginHookExternalContentProvenance | undefined,
  right: PluginHookExternalContentProvenance | undefined,
): PluginHookExternalContentProvenance | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const sources = new Set<ToolHookExternalContentSource>([...left.sources, ...right.sources]);
  return {
    present: true,
    sources: EXTERNAL_CONTENT_SOURCE_ORDER.filter((source) => sources.has(source)),
  };
}
