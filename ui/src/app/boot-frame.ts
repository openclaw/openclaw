/** The original data-free frame is the bounded fallback for a joined warm mount. */
export function finishBootFrame(): void {
  const root = document.documentElement;
  if (root.hasAttribute("data-openclaw-warm-frame")) {
    root.removeAttribute("data-openclaw-warm-frame");
    document.getElementById("openclaw-boot-shell")?.remove();
  }
}
