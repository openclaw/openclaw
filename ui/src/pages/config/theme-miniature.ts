import { isBuiltinThemeId } from "../../../../packages/gateway-protocol/src/theme-ids.ts";
import { resolveTheme, type ThemeMode, type ThemeName } from "../../app/theme.ts";

/** A scriptless document reuses the installed palette cascade without recoloring its owner. */
export function themeMiniatureDocument(theme: ThemeName, mode: ThemeMode): string {
  const miniature = document.implementation.createHTMLDocument("");
  // Inline the installed palette cascade. The scriptless frame has an opaque
  // origin, so fetching even local stylesheets can hit CORS or local-network gates.
  // Third-party font sheets are not needed for this text-free miniature.
  for (const sheet of document.styleSheets) {
    if (sheet.disabled || (sheet.href && new URL(sheet.href).origin !== location.origin)) {
      continue;
    }
    const style = miniature.createElement("style");
    style.media = sheet.media.mediaText;
    style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    miniature.head.append(style);
  }
  const root = miniature.documentElement;
  root.style.cssText = document.documentElement.style.cssText;
  const resolved = resolveTheme(theme, mode);
  root.dataset.theme = resolved;
  root.dataset.themeId = theme;
  root.dataset.themeMode = resolved.endsWith("light") ? "light" : "dark";
  root.dataset.themeResolved = root.dataset.themeMode;
  // Contrast remains owned by the application. External palettes keep authored colors.
  root.dataset.contrast = isBuiltinThemeId(theme)
    ? (document.documentElement.dataset.contrast ?? "standard")
    : "standard";
  const style = miniature.createElement("style");
  style.textContent = `
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body { display: grid; place-items: center; background: var(--bg); }
    main { display: grid; grid-template-columns: 25% 1fr; width: 78%; height: 66%;
      overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); }
    nav { display: grid; align-content: start; gap: 6px; padding: 12px 8px;
      background: var(--card); border-inline-end: 1px solid var(--border); }
    section { display: grid; align-content: start; gap: 7px; padding: 12px 8px;
      background: var(--bg); }
    i { display: block; height: 3px; border-radius: 2px; background: var(--muted); }
    nav i:first-child { background: var(--accent); }
    section i:first-child { width: 95%; background: var(--accent-2); }
    section i:nth-child(2) { width: 72%; }
    section i:last-child { width: 42%; height: 6px; background: var(--primary); }
  `;
  miniature.head.append(style);
  const main = miniature.createElement("main");
  for (const tag of ["nav", "section"]) {
    const group = miniature.createElement(tag);
    for (let index = 0; index < 3; index += 1) {
      group.append(miniature.createElement("i"));
    }
    main.append(group);
  }
  miniature.body.append(main);
  return "<!doctype html>" + root.outerHTML;
}
