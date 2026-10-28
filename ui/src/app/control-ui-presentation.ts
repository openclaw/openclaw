import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  hexToOklch,
  prepareParticipantPalette,
  type Oklch,
} from "../lib/chat/participant-colors.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { controlUiAccentInk } from "./accent-contrast.ts";
import { controlUiDocumentHead } from "./control-ui-document-head.ts";
import { controlUiPaletteStyle } from "./control-ui-palette-style.ts";

const ACCENT_CSS_VARIABLES = [
  "--ring",
  "--accent",
  "--accent-foreground",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--accent-glow",
  "--primary",
  "--primary-hover",
  "--primary-foreground",
  "--focus",
  "--focus-ring",
  "--focus-glow",
] as const;

let participantPaletteValue: ReturnType<typeof prepareParticipantPalette> | undefined;
let participantPaletteKey = "";
const participantPaletteListeners = createChangeListeners();

export const controlUiParticipantPalette = {
  get current() {
    return participantPaletteValue;
  },
  subscribe: participantPaletteListeners.subscribe,
};

/** Resolve modern CSS ink without quantizing its hue/chroma through an 8-bit canvas. */
function resolveLinkColors(root: HTMLElement, normal: string, hover: string) {
  if (!normal || !hover) {
    return undefined;
  }
  const probe = document.createElement("span");
  probe.hidden = true;
  root.append(probe);
  const computed = getComputedStyle(probe);
  const read = (color: string): Oklch | undefined => {
    probe.style.color = `oklch(from ${color} l c h)`;
    const values = computed.color.match(/^oklch\(([^)]+)\)$/u)?.[1]?.split(/\s+/u);
    if (!values || values.length < 3) {
      return undefined;
    }
    const [l, c, h] = values.slice(0, 3).map((value) => (value === "none" ? 0 : Number(value)));
    return Number.isFinite(l) && Number.isFinite(c) && Number.isFinite(h)
      ? { l: l!, c: c!, h: h! }
      : undefined;
  };
  try {
    const normalColor = read(normal);
    const hoverColor = read(hover);
    return normalColor && hoverColor ? { normal: normalColor, hover: hoverColor } : undefined;
  } finally {
    probe.remove();
  }
}

let operatorSeamColor: string | undefined;
let userAccentOverride: string | undefined;
const systemChromeRevisions = new WeakMap<HTMLElement, { source: string; palette: string }>();

// Project the independently rendered shell into the static document's chrome and head metadata.
export function syncControlUiSystemChrome(paletteChanged = false, chatShell?: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const hasChatShell = chatShell ?? root.classList.contains("control-ui-chat-shell");
  if (root.classList.contains("control-ui-chat-shell") !== hasChatShell) {
    root.classList.toggle("control-ui-chat-shell", hasChatShell);
  }
  const narrow = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  ).matches;
  const revision = (style: string | null) =>
    JSON.stringify([root.dataset.theme, root.dataset.themeMode, style, narrow && hasChatShell]);
  const source = revision(root.getAttribute("style"));
  const previous = systemChromeRevisions.get(root);
  // Most shell commits do not touch styles. Keep that path free of declaration scans.
  if (!paletteChanged && previous?.source === source) {
    return;
  }
  const palette = revision(controlUiPaletteStyle(root));
  if (!paletteChanged && previous?.palette === palette) {
    systemChromeRevisions.set(root, { source, palette });
    return;
  }
  const computedStyle = getComputedStyle(root);
  const canvas = resolveThemeColor(computedStyle, "--bg-content");
  const accent = resolveThemeColor(computedStyle, "--accent");
  const mode = root.dataset.themeMode === "light" ? "light" : "dark";
  const link = computedStyle.getPropertyValue("--link").trim();
  const linkHover = computedStyle.getPropertyValue("--link-hover").trim();
  const nextParticipantKey = JSON.stringify([canvas, accent, link, linkHover, mode]);
  if (
    nextParticipantKey !== participantPaletteKey &&
    /^#[\da-f]{6}$/iu.test(canvas) &&
    /^#[\da-f]{6}$/iu.test(accent)
  ) {
    const links = resolveLinkColors(root, link, linkHover);
    if (links) {
      participantPaletteKey = nextParticipantKey;
      participantPaletteValue = prepareParticipantPalette(
        { mode, background: hexToOklch(canvas), accent: hexToOklch(accent) },
        links,
      );
      root.style.setProperty("--chat-canvas-link", participantPaletteValue.canvasLinks.normal);
      root.style.setProperty("--chat-canvas-link-hover", participantPaletteValue.canvasLinks.hover);
      participantPaletteListeners.publish();
    }
  }
  const pageBackground = computedStyle.getPropertyValue("--bg").trim();
  const background =
    narrow && hasChatShell
      ? computedStyle.getPropertyValue("--bg-content").trim() || pageBackground
      : pageBackground;
  if (!background) {
    return;
  }
  root.style.setProperty("--control-ui-system-chrome-background", background);
  for (const meta of controlUiDocumentHead().themeColors) {
    meta.content = background;
    meta.removeAttribute("media");
  }
  systemChromeRevisions.set(root, { source: revision(root.getAttribute("style")), palette });
}

export function applyControlUiAccent(userAccent?: string): void {
  userAccentOverride = userAccent;
  const root = document.documentElement;
  // An explicit theme selection must not expose the lower-precedence seam color.
  const accent =
    userAccentOverride === "theme" ? undefined : (userAccentOverride ?? operatorSeamColor);
  const hex = accent?.trim().replace(/^#/, "");
  const color = hex && /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
  if (!color) {
    for (const property of ACCENT_CSS_VARIABLES) {
      root.style.removeProperty(property);
    }
    return;
  }

  const ink = controlUiAccentInk(color);
  const mix = (variable: string, amount: number) =>
    `color-mix(in srgb, var(${variable}) ${amount}%, transparent)`;

  for (const property of ["--ring", "--accent", "--accent-muted", "--primary"]) {
    root.style.setProperty(property, color);
  }
  for (const property of ["--accent-foreground", "--primary-foreground"]) {
    root.style.setProperty(property, ink);
  }
  root.style.setProperty("--accent-hover", "color-mix(in srgb, var(--accent) 82%, white 18%)");
  root.style.setProperty("--primary-hover", "color-mix(in srgb, var(--primary) 82%, white 18%)");
  root.style.setProperty("--accent-subtle", mix("--accent", 16));
  root.style.setProperty("--accent-glow", mix("--accent", 30));
  root.style.setProperty("--focus", mix("--ring", 22));
  root.style.setProperty("--focus-ring", `0 0 0 2px var(--bg), 0 0 0 3px ${mix("--ring", 80)}`);
  root.style.setProperty(
    "--focus-glow",
    "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  );
}

export function applyControlUiOperatorSeamColor(seamColor?: string): void {
  operatorSeamColor = seamColor;
  applyControlUiAccent(userAccentOverride);
}
