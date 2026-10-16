import { controlUiAccentInk } from "./accent-contrast.ts";

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

let operatorSeamColor: string | undefined;
let userAccentOverride: string | undefined;
const systemChromeRevisions = new WeakMap<HTMLElement, string>();

export function syncControlUiSystemChrome(paletteChanged = false): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const chatShell = document.querySelector(".shell--chat") !== null;
  if (root.classList.contains("control-ui-chat-shell") !== chatShell) {
    root.classList.toggle("control-ui-chat-shell", chatShell);
  }
  const narrow = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  ).matches;
  const revision = () =>
    JSON.stringify([
      root.dataset.theme,
      root.dataset.themeMode,
      root.getAttribute("style"),
      narrow && chatShell,
    ]);
  if (!paletteChanged && systemChromeRevisions.get(root) === revision()) {
    return;
  }
  const computedStyle = getComputedStyle(root);
  const pageBackground = computedStyle.getPropertyValue("--bg").trim();
  const background =
    narrow && chatShell
      ? computedStyle.getPropertyValue("--bg-content").trim() || pageBackground
      : pageBackground;
  if (!background) {
    return;
  }
  root.style.setProperty("--control-ui-system-chrome-background", background);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background;
    meta.removeAttribute("media");
  }
  // Include our own output so the next shell commit does not invalidate the sample.
  systemChromeRevisions.set(root, revision());
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
