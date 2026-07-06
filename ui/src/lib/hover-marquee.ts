// Hover marquee for truncated single-line labels: on pointer enter, animate
// text-indent to slide the clipped tail into view; on leave, the base
// transition in styles/components.css (.hover-marquee) snaps it back quickly.
// text-indent (not an inner transform wrapper) because text-overflow renders
// no ellipsis for atomic inline children, which would lose the resting "…".
const MARQUEE_SPEED_PX_PER_SEC = 80;
const MARQUEE_MIN_DURATION_MS = 300;

function findMarqueeLabel(host: HTMLElement): HTMLElement | null {
  return host.classList.contains("hover-marquee")
    ? host
    : host.querySelector<HTMLElement>(".hover-marquee");
}

export function startHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  // Measure at hover time: labels resize with the sidebar and with hover-only
  // row actions, so a cached width would drift. A negative mid-transition
  // indent (re-hover while snapping back) shrinks scrollWidth; add it back.
  const indent = Number.parseFloat(getComputedStyle(label).textIndent) || 0;
  const shift = label.scrollWidth - indent - label.clientWidth;
  if (shift <= 1) {
    return;
  }
  const durationMs = Math.max(
    MARQUEE_MIN_DURATION_MS,
    Math.round((shift / MARQUEE_SPEED_PX_PER_SEC) * 1000),
  );
  label.style.setProperty("--hover-marquee-shift", `${-shift}px`);
  label.style.setProperty("--hover-marquee-duration", `${durationMs}ms`);
  label.classList.add("hover-marquee--scrolling");
}

export function stopHoverMarquee(host: HTMLElement): void {
  findMarqueeLabel(host)?.classList.remove("hover-marquee--scrolling");
}
