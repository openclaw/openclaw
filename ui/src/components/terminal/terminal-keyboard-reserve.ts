/**
 * Soft-keyboard viewport reserve for the ghostty terminal on Android.
 *
 * On a Galaxy Z Fold6 (Chrome, Android) with the soft keyboard open:
 *   innerHeight = 676, visualViewport.height = 363, offsetTop = 0
 *   => gap = 313 px
 *
 * The page declares `interactive-widget=resizes-content`, which by spec
 * should make this gap zero, but Chrome on the Fold6 does not resize the
 * layout viewport when the keyboard is shown. The 313 px gap is real and
 * covers the terminal canvas. ghostty's FitAddon computes row count from
 * `container.clientHeight - paddingTop - paddingBottom`, so setting
 * `padding-bottom` on the ghostty container is enough to prevent the canvas
 * from being painted behind the keyboard -- no synthetic resize events needed.
 *
 * Pinch-zoom guard: at page scale 2 with no keyboard, innerHeight 915 vs
 * visualViewport.height 457.5 yields a false ~458 px reserve that would
 * collapse the terminal. The scale check (`Math.abs(scale - 1) <= 0.01`)
 * suppresses the reserve at non-unit zoom.
 *
 * Remove this workaround when Chrome on Android respects
 * `interactive-widget=resizes-content` for `innerHeight`, or when ghostty
 * provides a direct API to account for the keyboard inset.
 */

/**
 * Computes the current soft-keyboard inset in pixels.
 *
 * Returns 0 when:
 * - `window.visualViewport` is unavailable.
 * - The page scale is not approximately 1 (pinch-zoom guard).
 * - The computed gap is 1 px or less (rounding noise tolerance).
 */
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) {
    return 0;
  }
  // Pinch-zoom guard: at non-unit scale the innerHeight / vv.height ratio
  // reflects zoom, not the keyboard. Suppress the reserve entirely.
  const scale = vv.scale;
  if (Math.abs(scale - 1) > 0.01) {
    return 0;
  }
  // gap = space between the visual viewport top edge (accounting for scrolled
  // offset) and the bottom of the layout viewport. When the soft keyboard is
  // open this equals the keyboard height on Chrome/Android despite the page
  // declaring interactive-widget=resizes-content.
  //
  // This reads window.innerHeight rather than the
  // `documentElement.clientHeight || innerHeight` pairing used elsewhere in the
  // app (see chat-composer-dom.ts). That pairing prefers the layout viewport
  // excluding classic scrollbars, which is right when positioning against
  // document flow. The quantity needed here is specifically the one the
  // keyboard does not move: innerHeight held at 676 across the keyboard
  // opening while visualViewport.height dropped to 363. Substituting
  // clientHeight would reintroduce a dependency on the layout-viewport resize
  // whose absence this workaround exists to handle.
  const gap = window.innerHeight - (vv.height + vv.offsetTop);
  return gap > 1 ? Math.round(gap) : 0;
}

/**
 * Observes soft-keyboard visibility and applies a matching `padding-bottom`
 * to `container` to reserve space so the ghostty canvas is not painted
 * behind the keyboard on Android.
 *
 * Only installed on coarse-pointer touch devices. Returns a cleanup function
 * that removes all listeners and clears the reserved padding.
 *
 * @param container - The ghostty container element (`options.parent` from
 *   `createIsolatedGhosttyTerminal`).
 * @returns A cleanup function.
 */
export function observeTerminalKeyboardReserve(container: HTMLElement): () => void {
  // Guard: coarse-pointer touch devices only.
  if (
    !(navigator.maxTouchPoints > 0) ||
    !(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches)
  ) {
    return () => {};
  }

  let rafHandle: number | null = null;
  const vv = window.visualViewport;

  function applyReserve(): void {
    rafHandle = null;
    const inset = keyboardInset();
    container.style.paddingBottom = inset > 0 ? `${inset}px` : "";
  }

  function scheduleUpdate(): void {
    if (rafHandle !== null) {
      return;
    }
    rafHandle = requestAnimationFrame(applyReserve);
  }

  window.addEventListener("resize", scheduleUpdate, { passive: true });
  vv?.addEventListener("resize", scheduleUpdate);
  vv?.addEventListener("scroll", scheduleUpdate);

  // Apply immediately so the reserve is correct before the first RAF.
  scheduleUpdate();

  return () => {
    window.removeEventListener("resize", scheduleUpdate);
    vv?.removeEventListener("resize", scheduleUpdate);
    vv?.removeEventListener("scroll", scheduleUpdate);
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    container.style.paddingBottom = "";
  };
}
