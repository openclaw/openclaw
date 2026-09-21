import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

const MARQUEE_SPEED_PX_PER_SEC = 40;
const MARQUEE_HOVER_DELAY_MS = 500;
const MARQUEE_LOOP_TRAVEL_FRACTION = 0.4;

type MarqueeOptions = { delay?: number; speed?: number; loop?: boolean };

const pendingMarquees = new Set<() => (() => void) | undefined>();
let marqueeFrame: number | undefined;

class HoverMarqueeDirective extends AsyncDirective {
  private label?: HTMLElement;
  private text?: HTMLElement;
  private host?: HTMLElement;
  private observer?: ResizeObserver;
  private contentObserver?: MutationObserver;
  private visibilityObserver?: IntersectionObserver;
  private visible = true;
  private motion?: MediaQueryList;
  private timer?: number;
  private readyToScroll = false;
  private options: MarqueeOptions = {};
  private className?: string;
  private shift = 0;

  render(_options: MarqueeOptions, _className: string) {
    return nothing;
  }

  override update(part: ElementPart, [options, className]: [MarqueeOptions, string]) {
    this.label = part.element instanceof HTMLElement ? part.element : undefined;
    if (
      !this.host ||
      className !== this.className ||
      options.delay !== this.options.delay ||
      options.speed !== this.options.speed ||
      options.loop !== this.options.loop
    ) {
      this.schedule();
    }
    this.options = { ...options };
    this.className = className;
    return nothing;
  }

  protected override reconnected() {
    this.schedule();
  }

  protected override disconnected() {
    pendingMarquees.delete(this.measure);
    if (pendingMarquees.size === 0 && marqueeFrame !== undefined) {
      cancelAnimationFrame(marqueeFrame);
      marqueeFrame = undefined;
    }
    this.stop();
    this.observer?.disconnect();
    this.observer = undefined;
    this.contentObserver?.disconnect();
    this.contentObserver = undefined;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = undefined;
    this.visible = true;
    this.motion?.removeEventListener("change", this.schedule);
    for (const event of ["pointerenter", "pointerleave", "focusin", "focusout"]) {
      this.host?.removeEventListener(event, this.schedule);
    }
    this.host = undefined;
  }

  private readonly schedule = () => {
    if (!this.isConnected) {
      return;
    }
    pendingMarquees.add(this.measure);
    if (marqueeFrame !== undefined) {
      return;
    }
    // Lit commits children after this directive; hover controls also need to
    // reserve their space before the title's viewport is measured.
    marqueeFrame = requestAnimationFrame(() => {
      marqueeFrame = undefined;
      const batch = [...pendingMarquees];
      pendingMarquees.clear();
      // A sidebar can invalidate hundreds of titles together. Finish every
      // geometry read before applying any title's overflow or animation styles.
      const updates = batch.map((measure) => measure());
      updates.forEach((update) => update?.());
    });
  };

  private readonly measure = () => {
    const label = this.label;
    if (!this.isConnected || !label?.isConnected) {
      return undefined;
    }
    if (!this.host) {
      this.text = label.querySelector<HTMLElement>(".hover-marquee__text") ?? undefined;
      this.host =
        label.closest<HTMLElement>(
          ".session-row-host, .sidebar-recent-sessions__head, .sidebar-identity-card, .sidebar-agent-card__main, .sidebar-workspace-header__main",
        ) ?? undefined;
      if (!this.host || !this.text) {
        return undefined;
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
      // Text can change auto direction without resizing; touch menus change
      // intent without another pointer/focus event. Observe those actual inputs.
      this.contentObserver = new MutationObserver(this.schedule);
      this.contentObserver.observe(label, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["dir"],
      });
      this.contentObserver.observe(this.host, {
        attributes: true,
        attributeFilter: ["aria-expanded", "dir"],
      });
      this.contentObserver.observe(label.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ["dir"],
      });
    }
    if (this.options.loop && !this.visibilityObserver) {
      // Mobile drawers move offscreen without resizing their names or
      // reliably clearing touch hover. Stop their loops while hidden.
      this.visibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          this.visible = entry.isIntersecting;
        }
        this.schedule();
      });
      this.visibilityObserver.observe(label);
    } else if (!this.options.loop && this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = undefined;
      this.visible = true;
    }
    const text = this.text!;
    const style = getComputedStyle(label);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const overflow =
      style.whiteSpace === "nowrap" && label.clientWidth > 0
        ? text.scrollWidth + padding - label.clientWidth
        : 0;
    const clipped = overflow > (this.options.loop ? 0 : 1);
    const active =
      this.host.matches(":hover, :focus-visible") ||
      Boolean(this.host.querySelector(":focus-visible")) ||
      // Touch opens the existing identity menu; its trigger keeps revealing
      // the name while focus moves into the portaled menu.
      (this.options.loop && this.host.getAttribute("aria-expanded") === "true");
    if (!clipped || !active || !this.visible || this.motion?.matches) {
      return () => {
        label.classList.toggle("hover-marquee--overflowing", clipped);
        this.stop();
        if (!clipped) {
          label.style.removeProperty("--hover-marquee-shift");
          label.style.removeProperty("--hover-marquee-duration");
          this.shift = 0;
        }
      };
    }
    const fade = Number.parseFloat(style.getPropertyValue("--hover-marquee-fade-width"));
    const shift =
      (overflow + (this.options.loop ? 0 : fade)) * (style.direction === "rtl" ? 1 : -1);
    const scrolling = label.classList.contains("hover-marquee--scrolling");
    let duration: number | undefined;
    if (shift !== this.shift || !scrolling) {
      const transform = getComputedStyle(text).transform;
      const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
      // Each leg occupies 40% of the loop; the rest pauses at either end.
      const distance = this.options.loop
        ? Math.abs(shift) / MARQUEE_LOOP_TRAVEL_FRACTION
        : Math.abs(shift - offset);
      duration = (distance / (this.options.speed ?? MARQUEE_SPEED_PX_PER_SEC)) * 1000;
    }
    return () => {
      label.classList.toggle("hover-marquee--overflowing", clipped);
      if (duration !== undefined) {
        label.style.setProperty("--hover-marquee-shift", `${shift}px`);
        label.style.setProperty("--hover-marquee-duration", `${duration}ms`);
        this.shift = shift;
      }
      if (this.readyToScroll) {
        this.readyToScroll = false;
        label.classList.add("hover-marquee--scrolling");
      } else if (this.timer === undefined && !scrolling) {
        this.timer = window.setTimeout(() => {
          this.timer = undefined;
          this.readyToScroll = true;
          this.schedule();
        }, this.options.delay ?? MARQUEE_HOVER_DELAY_MS);
      }
    };
  };

  private stop() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.readyToScroll = false;
    this.label?.classList.remove("hover-marquee--scrolling");
  }
}

const hoverMarquee = directive(HoverMarqueeDirective);

export function renderHoverMarquee(
  content: unknown,
  className: string,
  options: MarqueeOptions = {},
) {
  return html`<span
    class="${className} hover-marquee ${options.loop ? "hover-marquee--loop" : ""}"
    dir=${options.loop ? "auto" : nothing}
    ${hoverMarquee(options, className)}
    ><span class="hover-marquee__text">${content}</span></span
  >`;
}
