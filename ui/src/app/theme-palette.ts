import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  makeTokenMap,
  requireSafeCssValue,
  requireSafeFontFamilyValue,
  type ImportedCustomTheme,
} from "./custom-theme.ts";

const DEFAULT_FONT_BODY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const DEFAULT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace';
const SAFE_COLOR_KEYWORDS = new Set(["black", "white", "transparent", "currentcolor"]);
const SAFE_COLOR_FUNCTION_PATTERN =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9+\-.,/%\s]+\)$/i;
const SAFE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function requireSafeExternalColorValue(value: unknown, label: string) {
  const normalized = requireSafeCssValue(value, label);
  const lowered = normalized.toLowerCase();
  if (
    SAFE_COLOR_KEYWORDS.has(lowered) ||
    SAFE_HEX_COLOR_PATTERN.test(normalized) ||
    SAFE_COLOR_FUNCTION_PATTERN.test(normalized)
  ) {
    return normalized;
  }
  throw new Error(`Unsupported tweakcn token: ${label}`);
}

function requireSafeExternalModeValue(value: unknown, label: string) {
  if (label === "font-sans" || label === "font-mono") {
    return requireSafeFontFamilyValue(value, label);
  }
  return requireSafeExternalColorValue(value, label);
}

function resolveModeVar(
  theme: Record<string, unknown>,
  shared: Record<string, unknown> | undefined,
  key: string,
  fallback?: string,
) {
  const value = normalizeOptionalString(theme[key]) ?? normalizeOptionalString(shared?.[key]);
  if (value) {
    return requireSafeExternalModeValue(value, key);
  }
  if (fallback != null) {
    return key === "font-sans" || key === "font-mono"
      ? requireSafeFontFamilyValue(fallback, key)
      : requireSafeCssValue(fallback, key);
  }
  throw new Error(`tweakcn theme is missing required token: ${key}`);
}

export function normalizeThemePalette(
  mode: "light" | "dark",
  theme: Record<string, unknown>,
  shared: Record<string, unknown> | undefined,
): ImportedCustomTheme["light"] {
  const isLight = mode === "light";
  const contrastTarget = isLight ? "black" : "white";
  const background = resolveModeVar(theme, shared, "background");
  const foreground = resolveModeVar(theme, shared, "foreground");
  const card = resolveModeVar(theme, shared, "card");
  const cardForeground = resolveModeVar(theme, shared, "card-foreground");
  const popover = resolveModeVar(theme, shared, "popover");
  const popoverForeground = resolveModeVar(theme, shared, "popover-foreground");
  const primary = resolveModeVar(theme, shared, "primary");
  const primaryForeground = resolveModeVar(theme, shared, "primary-foreground");
  const secondary = resolveModeVar(theme, shared, "secondary");
  const secondaryForeground = resolveModeVar(theme, shared, "secondary-foreground");
  const muted = resolveModeVar(theme, shared, "muted");
  const mutedForeground = resolveModeVar(theme, shared, "muted-foreground");
  const accent = resolveModeVar(theme, shared, "accent");
  const accentForeground = resolveModeVar(theme, shared, "accent-foreground");
  const destructive = resolveModeVar(theme, shared, "destructive");
  const destructiveForeground = resolveModeVar(theme, shared, "destructive-foreground");
  const border = resolveModeVar(theme, shared, "border");
  const input = resolveModeVar(theme, shared, "input");
  const ring = resolveModeVar(theme, shared, "ring");
  const fontBody = resolveModeVar(theme, shared, "font-sans", DEFAULT_FONT_BODY);
  const mono = resolveModeVar(theme, shared, "font-mono", DEFAULT_MONO);

  return makeTokenMap([
    ["bg", background],
    ["bg-accent", "color-mix(in srgb, var(--bg) 88%, var(--card) 12%)"],
    ["bg-elevated", card],
    ["bg-hover", "color-mix(in srgb, var(--muted) 68%, var(--bg) 32%)"],
    ["bg-muted", muted],
    ["bg-content", "color-mix(in srgb, var(--bg) 92%, var(--card) 8%)"],
    ["card", card],
    ["card-foreground", cardForeground],
    ["card-highlight", `color-mix(in srgb, var(--text) ${isLight ? "3" : "5"}%, transparent)`],
    ["popover", popover],
    ["popover-foreground", popoverForeground],
    ["panel", background],
    ["panel-strong", card],
    ["panel-hover", "color-mix(in srgb, var(--card) 76%, var(--muted) 24%)"],
    ["chrome", "color-mix(in srgb, var(--bg) 96%, transparent)"],
    ["chrome-strong", "color-mix(in srgb, var(--bg) 98%, transparent)"],
    ["text", foreground],
    ["text-strong", foreground],
    ["chat-text", foreground],
    ["muted", mutedForeground],
    ["muted-strong", "color-mix(in srgb, var(--muted) 84%, var(--text) 16%)"],
    ["muted-foreground", mutedForeground],
    ["border", border],
    ["border-strong", "color-mix(in srgb, var(--border) 72%, var(--text) 28%)"],
    ["border-hover", "color-mix(in srgb, var(--border) 55%, var(--text) 45%)"],
    ["input", input],
    ["ring", ring],
    ["accent", accent],
    ["accent-hover", `color-mix(in srgb, var(--accent) 82%, ${contrastTarget} 18%)`],
    ["accent-muted", accent],
    ["accent-subtle", `color-mix(in srgb, var(--accent) ${isLight ? "10" : "16"}%, transparent)`],
    ["accent-foreground", accentForeground],
    ["accent-glow", `color-mix(in srgb, var(--accent) ${isLight ? "18" : "30"}%, transparent)`],
    ["primary", primary],
    ["primary-foreground", primaryForeground],
    ["secondary", secondary],
    ["secondary-foreground", secondaryForeground],
    ["accent-2", primary],
    ["accent-2-muted", "color-mix(in srgb, var(--accent-2) 72%, transparent)"],
    [
      "accent-2-subtle",
      `color-mix(in srgb, var(--accent-2) ${isLight ? "8" : "12"}%, transparent)`,
    ],
    ["destructive", destructive],
    ["destructive-foreground", destructiveForeground],
    ["danger", destructive],
    ["danger-muted", "color-mix(in srgb, var(--danger) 75%, transparent)"],
    ["danger-subtle", `color-mix(in srgb, var(--danger) ${isLight ? "8" : "12"}%, transparent)`],
    ["focus", `color-mix(in srgb, var(--ring) ${isLight ? "14" : "22"}%, transparent)`],
    [
      "focus-ring",
      `0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) ${isLight ? "70" : "80"}%, transparent)`,
    ],
    ["focus-glow", "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)"],
    ["font-body", fontBody],
    ["font-display", fontBody],
    ["mono", mono],
    ["grid-line", `color-mix(in srgb, var(--text) ${isLight ? "4" : "3"}%, transparent)`],
  ]);
}
