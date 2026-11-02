import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  hexToOklch,
  prepareParticipantPalette,
  prepareThemeLinks,
} from "../lib/chat/participant-colors.ts";
import { resolveThemeColor, resolveThemeColors } from "../lib/theme-color.ts";
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
