import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

const MARQUEE_SPEED_PX_PER_SEC = 40;
const MARQUEE_HOVER_DELAY_MS = 500;

type MarqueeOptions = { delay?: number; speed?: number };

class HoverMarqueeDirective extends AsyncDirective {
  private label?: HTMLElement;
  private text?: HTMLElement;
  private host?: HTMLElement;
  private observer?: ResizeObserver;
  private motion?: MediaQueryList;
  private frame?: number;
  private timer?: number;
  private options: MarqueeOptions = {};
  private shift = 0;

  render(_options: MarqueeOptions) {
    return nothing;
  }

  override update(part: ElementPart, [options]: [MarqueeOptions]) {
    this.label = part.element instanceof HTMLElement ? part.element : undefined;
    this.options = options;
    this.schedule();
    return nothing;
  }

  protected override reconnected() {
    this.schedule();
  }

  protected override disconnected() {
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    this.stop();
    this.observer?.disconnect();
    this.observer = undefined;
    this.motion?.removeEventListener("change", this.schedule);
    for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"]) {
      this.host?.removeEventListener(event, this.schedule);
    }
    this.host = undefined;
  }

  private readonly schedule = () => {
    if (this.frame !== undefined || !this.isConnected) {
      return;
    }
    // Lit commits children after this directive; hover controls also need to
    // reserve their space before the title's viewport is measured.
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.measure();
    });
  };

  private measure() {
    const label = this.label;
    if (!this.isConnected || !label?.isConnected) {
      return;
    }
    if (!this.host) {
      this.text = label.querySelector<HTMLElement>(".hover-marquee__text") ?? undefined;
      this.host =
        label.closest<HTMLElement>(".session-row-host, .sidebar-recent-sessions__head") ??
        undefined;
      if (!this.host || !this.text) {
        return;
      }
      for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"]) {
        this.host.addEventListener(event, this.schedule);
      }
      this.motion = matchMedia("(prefers-reduced-motion: reduce)");
      this.motion.addEventListener("change", this.schedule);
      // Observe each node once per connected lifetime. Transforms do not resize
      // the text, so scrolling cannot invalidate its own measurement.
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(label);
      this.observer.observe(this.text);
    }
    const text = this.text!;
    const style = getComputedStyle(label);
    const overflow = style.whiteSpace === "nowrap" ? text.offsetWidth - label.clientWidth : 0;
    const clipped = overflow > 1;
    label.classList.toggle("hover-marquee--overflowing", clipped);
    const active =
      this.host.matches(":hover, :focus-visible") ||
      Boolean(this.host.querySelector(":focus-visible"));
    if (!clipped || !active || this.motion?.matches) {
      this.stop();
      if (!clipped) {
        label.style.removeProperty("--hover-marquee-shift");
        label.style.removeProperty("--hover-marquee-duration");
        this.shift = 0;
      }
      return;
    }
    const fade = Number.parseFloat(style.getPropertyValue("--hover-marquee-fade-width"));
    const shift = (overflow + fade) * (style.direction === "rtl" ? 1 : -1);
    if (shift !== this.shift || !label.classList.contains("hover-marquee--scrolling")) {
      const transform = getComputedStyle(text).transform;
      const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
      const duration =
        (Math.abs(shift - offset) / (this.options.speed ?? MARQUEE_SPEED_PX_PER_SEC)) * 1000;
      label.style.setProperty("--hover-marquee-shift", `${shift}px`);
      label.style.setProperty("--hover-marquee-duration", `${duration}ms`);
      this.shift = shift;
    }
    if (this.timer === undefined && !label.classList.contains("hover-marquee--scrolling")) {
      this.timer = window.setTimeout(() => {
        this.measure();
        if (this.timer !== undefined) {
          this.timer = undefined;
          label.classList.add("hover-marquee--scrolling");
        }
      }, this.options.delay ?? MARQUEE_HOVER_DELAY_MS);
    }
  }

  private stop() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.label?.classList.remove("hover-marquee--scrolling");
  }
}

const hoverMarquee = directive(HoverMarqueeDirective);

export function renderHoverMarquee(
  content: unknown,
  className: string,
  options: MarqueeOptions = {},
) {
  return html`<span class="${className} hover-marquee" ${hoverMarquee(options)}
    ><span class="hover-marquee__text">${content}</span></span
  >`;
}
