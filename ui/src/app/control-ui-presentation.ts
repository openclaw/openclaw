import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  hexToOklch,
  prepareParticipantPalette,
  prepareThemeLinks,
} from "../lib/chat/participant-colors.ts";
import { resolveThemeColor, resolveThemeColors } from "../lib/theme-color.ts";
import { controlUiAccentFocus, controlUiAccentStates } from "./accent-contrast.ts";
import { controlUiDocumentHead } from "./control-ui-document-head.ts";
import { controlUiPaletteStyle } from "./control-ui-palette-style.ts";
import { themePaletteRevision } from "./theme.ts";

const ACCENT_CSS_VARIABLES = [
  "--ring",
  "--accent",
  "--accent-foreground",
  "--accent-hover",
  "--accent-active",
  "--accent-muted",
  "--accent-subtle",
  "--accent-glow",
  "--primary",
  "--primary-hover",
  "--primary-active",
  "--primary-foreground",
  "--chat-send-foreground",
  "--chat-send-hover-bg",
  "--chat-send-active-bg",
  "--focus",
  "--focus-ring",
  "--focus-glow",
] as const;

const LINK_SURFACES = [
  "--bg",
  "--bg-muted",
  "--bg-elevated",
  "--card",
  "--panel",
  "--popover",
] as const;
const LINK_OVERLAYS = [
  "--inline-code-bg",
  "--accent-subtle",
  "--person-reference-bg",
  "--person-reference-hover-bg",
] as const;

let participantPaletteValue: ReturnType<typeof prepareParticipantPalette> | undefined;
let participantPaletteKey = "";
let themeLinksKey = "";
let themeLinksValue: ReturnType<typeof prepareThemeLinks> | undefined;
const participantPaletteListeners = createChangeListeners();

export const controlUiParticipantPalette = {
  get current() {
    return participantPaletteValue;
  },
  subscribe: participantPaletteListeners.subscribe,
};

let operatorSeamColor: string | undefined;
let userAccentOverride: string | undefined;
const systemChromeRevisions = new WeakMap<
  HTMLElement,
  {
    source: string;
    palette: string;
    narrowCanvas: boolean;
    navScrim: boolean;
    pageBackground: string;
    canvasBackground: string;
  }
>();

/** The committed shell surfaces that border the system chrome. */
export type ControlUiShellChrome = {
  /** The route leaves the shell's --bg-content canvas exposed at the narrow viewport edges;
   * every other layout, including the session workbench, paints --bg. */
  contentCanvas: boolean;
  /** The mobile navigation drawer's backdrop dims the whole app canvas. */
  navScrim: boolean;
};

// The last committed shell; theme and breakpoint owners resync without one.
let committedShell: ControlUiShellChrome = { contentCanvas: false, navScrim: false };

// Opacity of the black `.shell--mobile-nav .shell-nav-backdrop` fill.
const NAV_SCRIM_ALPHA = 0.44;

function behindNavScrim(color: string): string {
  if (!/^#[\da-f]{6}$/iu.test(color)) {
    return color;
  }
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(Number.parseInt(color.slice(index, index + 2), 16) * (1 - NAV_SCRIM_ALPHA))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// Project the independently rendered shell into the static document's chrome and head metadata.
export function syncControlUiSystemChrome(
  paletteChanged = false,
  shell?: ControlUiShellChrome,
): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  committedShell = shell ?? committedShell;
  const { contentCanvas, navScrim } = committedShell;
  const narrow = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  ).matches;
  const narrowCanvas = narrow && contentCanvas;
  // iOS Safari shows the document canvas around its browser chrome. Where that canvas
  // differs from the page surface, it follows the published chrome color.
  const documentCanvas = narrowCanvas || navScrim;
  const revision = (style: string | null) =>
    JSON.stringify([root.dataset.theme, root.dataset.themeMode, style, narrowCanvas, navScrim]);
  const source = revision(root.getAttribute("style"));
  const previous = systemChromeRevisions.get(root);
  // Most shell commits do not touch styles. Keep that path free of declaration scans.
  if (!paletteChanged && previous?.source === source) {
    return;
  }
  const palette = JSON.stringify([
    root.dataset.theme,
    root.dataset.themeMode,
    controlUiPaletteStyle(root),
  ]);
  const publishBackground = (pageBackground: string, canvasBackground: string) => {
    const surface = narrowCanvas ? canvasBackground || pageBackground : pageBackground;
    if (!surface) {
      return;
    }
    const background = navScrim ? behindNavScrim(surface) : surface;
    // Background color does not inherit: drawer changes must not invalidate
    // the entire transcript through a root class or custom property.
    root.style.backgroundColor = documentCanvas ? background : "";
    document.body.style.backgroundColor = documentCanvas ? background : "";
    for (const meta of controlUiDocumentHead().themeColors) {
      meta.content = background;
      meta.removeAttribute("media");
    }
    systemChromeRevisions.set(root, {
      source: revision(root.getAttribute("style")),
      palette,
      narrowCanvas,
      navScrim,
      pageBackground,
      canvasBackground,
    });
  };
  if (!paletteChanged && previous?.palette === palette) {
    // Routes and breakpoints select a prepared surface; they do not change its palette.
    if (previous.narrowCanvas === narrowCanvas && previous.navScrim === navScrim) {
      systemChromeRevisions.set(root, { ...previous, source });
    } else {
      publishBackground(previous.pageBackground, previous.canvasBackground);
    }
    return;
  }
  // Derived ink must not survive a reset or become the next palette's input.
  root.style.removeProperty("--link");
  root.style.removeProperty("--link-on-tint");
  const computedStyle = getComputedStyle(root);
  const canvas = resolveThemeColor(computedStyle, "--bg-content");
  const accent = resolveThemeColor(computedStyle, "--accent");
  const mode = root.dataset.themeMode === "light" ? "light" : "dark";
  const viewerTone =
    mode === "dark" && ["dark", "beacon", "rose", "miami"].includes(root.dataset.theme ?? "")
      ? { l: 0.34, c: 0.07 }
      : undefined;
  const nextParticipantKey = JSON.stringify([canvas, accent, mode, viewerTone]);
  if (/^#[\da-f]{6}$/iu.test(canvas) && /^#[\da-f]{6}$/iu.test(accent)) {
    const participantColors = {
      mode,
      background: hexToOklch(canvas),
      accent: hexToOklch(accent),
      viewerTone,
    } as const;
    if (nextParticipantKey !== participantPaletteKey) {
      participantPaletteKey = nextParticipantKey;
      participantPaletteValue = prepareParticipantPalette(participantColors);
      participantPaletteListeners.publish();
    }
    const custom =
      root.style.getPropertyValue("--accent") !== "" ||
      root.dataset.theme === "custom" ||
      root.dataset.theme === "custom-light";
    if (custom) {
      const values = (properties: readonly string[]) =>
        properties
          .map((property) => computedStyle.getPropertyValue(property).trim())
          .filter(Boolean);
      const surfaces = values(LINK_SURFACES);
      const overlays = values(LINK_OVERLAYS);
      const nextLinksKey = JSON.stringify([nextParticipantKey, surfaces, overlays]);
      if (nextLinksKey !== themeLinksKey) {
        const colors = resolveThemeColors([...surfaces, ...overlays]);
        themeLinksValue = undefined;
        if (colors) {
          themeLinksValue = prepareThemeLinks(
            participantColors,
            colors.slice(0, surfaces.length),
            colors.slice(surfaces.length),
          );
          themeLinksKey = nextLinksKey;
        }
      }
      if (themeLinksValue) {
        root.style.setProperty("--link", themeLinksValue.normal);
        root.style.setProperty("--link-on-tint", themeLinksValue.tint);
      }
    } else {
      themeLinksKey = "";
      themeLinksValue = undefined;
    }
  }
  // Browser chrome parses theme-color outside the cascade; publish concrete colors, not palette
  // expressions such as the color-mix() surfaces named themes derive from --bg-content.
  publishBackground(resolveThemeColor(computedStyle, "--bg"), canvas);
}

// The last projection's inputs and the --ring it wrote; repeated boot and config
// passes with unchanged inputs skip the style writes and forced recalcs.
let appliedAccent = "";

export function applyControlUiAccent(userAccent?: string): void {
  userAccentOverride = userAccent;
  const root = document.documentElement;
  // An explicit theme selection must not expose the lower-precedence seam color.
  const accent =
    userAccentOverride === "theme" ? undefined : (userAccentOverride ?? operatorSeamColor);
  const hex = accent?.trim().replace(/^#/, "");
  const color = hex && /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
  // Lazily loaded palette sheets and the custom theme tag can change the computed accent
  // behind unchanged theme attributes.
  const key = `${color} ${root.dataset.theme} ${root.dataset.themeMode} ${themePaletteRevision()} ${document.getElementById("openclaw-custom-theme")?.textContent}`;
  if (appliedAccent === key + root.style.getPropertyValue("--ring")) {
    return;
  }
  // Remove the previous projection before resolving the current theme's palette.
  for (const property of ACCENT_CSS_VARIABLES) {
    root.style.removeProperty(property);
  }
  if (color) {
    for (const property of ["--accent", "--accent-muted", "--primary"]) {
      root.style.setProperty(property, color);
    }
  }
  const computed = getComputedStyle(root);
  const accentColor = color ?? resolveThemeColor(computed, "--accent");
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) {
    return;
  }
  const focusSurfaces: string[] = [];
  for (const family of ["accent", "primary", "chat-send"]) {
    const source = family === "chat-send" ? "primary" : family;
    const background = color ?? resolveThemeColor(computed, "--" + source);
    const hoverProperty =
      family === "chat-send" ? "--chat-send-hover-bg" : "--" + family + "-hover";
    const hover = color ? undefined : resolveThemeColor(computed, hoverProperty) || undefined;
    const foreground = color
      ? undefined
      : resolveThemeColor(computed, "--" + family + "-foreground") || undefined;
    const states = controlUiAccentStates(background, hover, foreground);
    for (const [state, pair] of Object.entries(states)) {
      focusSurfaces.push(pair.background);
      if (family === "chat-send") {
        if (state !== "normal") {
          root.style.setProperty("--chat-send-" + state + "-bg", pair.background);
        }
      } else if (color || state !== "normal") {
        const suffix = state === "normal" ? "" : "-" + state;
        root.style.setProperty("--" + family + suffix, pair.background);
      }
      if (color && state === "normal") {
        root.style.setProperty("--" + family + "-foreground", pair.foreground);
      }
    }
  }
  const surfaces = [
    ...focusSurfaces,
    ...LINK_SURFACES.map((surface) => resolveThemeColor(computed, surface)).filter((surface) =>
      /^#[0-9a-f]{6}$/i.test(surface),
    ),
  ];
  root.style.setProperty("--ring", controlUiAccentFocus(accentColor, surfaces));
  const mix = (variable: string, amount: number) =>
    "color-mix(in srgb, var(" + variable + ") " + amount + "%, transparent)";
  if (color) {
    root.style.setProperty("--accent-subtle", mix("--accent", 16));
    root.style.setProperty("--accent-glow", mix("--accent", 30));
  }
  root.style.setProperty("--focus", mix("--ring", 22));
  root.style.setProperty("--focus-ring", "0 0 0 2px var(--bg), 0 0 0 3px var(--ring)");
  root.style.setProperty(
    "--focus-glow",
    "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  );
  appliedAccent = key + root.style.getPropertyValue("--ring");
}

export function applyControlUiOperatorSeamColor(seamColor?: string): void {
  operatorSeamColor = seamColor;
  applyControlUiAccent(userAccentOverride);
}
