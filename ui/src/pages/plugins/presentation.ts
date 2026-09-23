import { expectDefined } from "@openclaw/normalization-core";
import { takeGraphemes } from "../../lib/graphemes.ts";

export function resolvePluginCatalogIconUrl(
  plugin: { pluginId?: string; imageUrl?: string },
  urls: {
    pluginIconUrls: Readonly<Record<string, string>>;
    iconUrls: Readonly<Record<string, string>>;
  },
  failedUrls?: ReadonlySet<string>,
): string | null {
  const packageIcon = plugin.pluginId ? urls.pluginIconUrls[plugin.pluginId] : undefined;
  const catalogIcon = plugin.imageUrl ? urls.iconUrls[plugin.imageUrl] : undefined;
  return (
    [packageIcon, catalogIcon].find((url): url is string =>
      Boolean(url && !failedUrls?.has(url)),
    ) ?? null
  );
}

/**
 * Deterministic two-stop gradients for plugins without package icons so every
 * tile keeps a distinct identity instead of an empty box.
 */
const FALLBACK_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#f59e0b", "#ea580c"],
  ["#38bdf8", "#1d4ed8"],
  ["#34d399", "#047857"],
  ["#a855f7", "#6b21a8"],
  ["#f472b6", "#be185d"],
  ["#22d3ee", "#0e7490"],
  ["#fbbf24", "#b45309"],
  ["#818cf8", "#4338ca"],
  ["#4ade80", "#166534"],
  ["#fb7185", "#9f1239"],
];

export function pluginFallbackGradient(id: string): readonly [string, string] {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return expectDefined(
    FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length],
    "plugin fallback gradient palette entry",
  );
}

export function pluginMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const first = expectDefined(words[0], "plugin monogram first word");
  const second = words[1];
  const initials = second
    ? `${takeGraphemes(first, 1)}${takeGraphemes(second, 1)}`
    : takeGraphemes(first, 2);
  return initials.toLocaleUpperCase();
}
