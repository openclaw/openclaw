import rules from "./panel-tab-strip.css?inline";

const animation = `@keyframes tabstrip-pulse {
  50% {
    opacity: 0.35;
  }
}`;

export const nativePanelTabStripCss = `:is(openclaw-terminal-panel, openclaw-browser-panel, openclaw-desktop-panel, openclaw-link-reader-panel) {
${rules}
}\n${animation}`;
