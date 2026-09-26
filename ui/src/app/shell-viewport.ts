/** Keep the shell's bottom inside the visible viewport without moving fixed menus. */
export function connectShellViewport(host: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const layoutHeightUnit = globalThis.CSS?.supports?.("height", "100dvh") ? "100dvh" : "100vh";
  const events = new AbortController();
  let frame: number | null = null;
  const update = () => {
    frame = null;
    const viewportBottom = viewport.height + viewport.offsetTop;
    const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
    // A normal resize must remain CSS-driven: retaining the previous pixel height
    // until the next frame can resize the shell between two layout reads. Ignore
    // subpixel rounding and pinch zoom, which is magnification rather than an
    // occluded layout. Only visual-only occlusion needs a measured override.
    const obscured = viewport.scale === 1 && viewportBottom < layoutViewportHeight - 1;
    // offsetTop is in layout-viewport coordinates. Using height alone lifts
    // the footer twice when Safari pans the viewport to reveal the caret.
    // Standalone mode gives body the notch/home-bar insets and removes the
    // composer's duplicate gap. Neither body inset is available to the shell.
    const bodyStyle = getComputedStyle(document.body);
    const bodyInsets =
      (Number.parseFloat(bodyStyle.paddingTop) || 0) +
      (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    host.style.setProperty(
      "--shell-viewport-height",
      obscured
        ? `${Math.max(0, viewportBottom - bodyInsets)}px`
        : bodyInsets > 0
          ? `max(0px, calc(${layoutHeightUnit} - ${bodyInsets}px))`
          : layoutHeightUnit,
    );
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(update);
  };
  const options = { signal: events.signal };
  viewport.addEventListener("resize", schedule, options);
  viewport.addEventListener("scroll", schedule, options);
  window.addEventListener("resize", schedule, options);
  update();
  return () => {
    events.abort();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    host.style.removeProperty("--shell-viewport-height");
  };
}
