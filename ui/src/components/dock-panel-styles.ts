import rules from "./dock-panel.css?inline";

export const nativeDockPanelCss = `:is(openclaw-terminal-panel, openclaw-browser-panel, openclaw-desktop-panel) {
${rules
  .replace(/:host(?:\(([^)]+)\))?/gu, "&$1")
  // Another panel can inject these shared rules after embedded-position overrides.
  .replace(/:is\(\.bp,\s*\.tp\)/gu, ":where(.bp, .tp)")}
}`;
