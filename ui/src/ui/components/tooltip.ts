import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

export type TooltipPlacement = "top" | "bottom";
export type TooltipAlign = "start" | "center" | "end";

type TooltipPosition = {
  top: number;
  left: number;
  arrowLeft: number;
  placement: TooltipPlacement;
};

const TOOLTIP_GAP = 10;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_ARROW_MIN = 14;

export class OpenClawTooltip extends LitElement {
  @property() text = "";
  @property({ reflect: true }) placement: TooltipPlacement = "bottom";
  @property({ reflect: true }) align: TooltipAlign = "center";
  @state() private open = false;
  @state() private position: TooltipPosition | null = null;

  @query(".trigger") private triggerElement?: HTMLElement;
  @query(".tooltip") private tooltipElement?: HTMLElement;

  static override styles = css`
    :host {
      display: inline-flex;
      min-width: 0;
    }

    .trigger {
      display: inline-flex;
      min-width: 0;
    }

    .wrap {
      display: inline-flex;
      min-width: 0;
    }

    .tooltip {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 400;
      box-sizing: border-box;
      width: min(260px, calc(100vw - 16px));
      padding: 9px 11px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--popover, var(--bg-elevated));
      color: var(--popover-foreground, var(--text-strong));
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
      font-family:
        var(--font-sans),
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      text-align: left;
      white-space: normal;
      pointer-events: none;
      transform: translateY(0);
      transition:
        opacity 120ms ease,
        transform 120ms ease;
    }

    .tooltip::before {
      content: "";
      position: absolute;
      width: 8px;
      height: 8px;
      background: inherit;
      border: inherit;
      transform: rotate(45deg);
      left: var(--tooltip-arrow-left, 50%);
    }

    .tooltip[data-placement="bottom"]::before {
      top: -5px;
      border-right: 0;
      border-bottom: 0;
    }

    .tooltip[data-placement="top"]::before {
      bottom: -5px;
      border-left: 0;
      border-top: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      .tooltip {
        transition: none;
      }
    }
  `;

  override render() {
    const text = this.text.trim();
    const position = this.position;
    const tooltipStyle = position
      ? {
          left: `${position.left}px`,
          top: `${position.top}px`,
          "--tooltip-arrow-left": `${position.arrowLeft}px`,
        }
      : {
          left: "0px",
          top: "0px",
          visibility: "hidden",
        };
    return html`
      <span
        class="wrap"
        @pointerenter=${this.openTooltip}
        @pointerleave=${this.closeTooltip}
        @focusin=${this.openTooltip}
        @focusout=${this.closeTooltip}
      >
        <span class="trigger"><slot></slot></span>
        ${this.open && text
          ? html`
              <span
                class="tooltip"
                role="tooltip"
                data-placement=${position?.placement ?? this.placement}
                style=${styleMap(tooltipStyle)}
                >${text}</span
              >
            `
          : nothing}
      </span>
    `;
  }

  private openTooltip = async () => {
    if (!this.text.trim()) {
      return;
    }
    this.open = true;
    this.position = null;
    await this.updateComplete;
    this.placeTooltip();
  };

  private closeTooltip = () => {
    this.open = false;
    this.position = null;
  };

  private placeTooltip() {
    const trigger = this.triggerElement;
    const tooltip = this.tooltipElement;
    if (!trigger || !tooltip) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const preferredPlacement = this.resolvePlacement(triggerRect, tooltipRect, viewportHeight);
    const unclampedLeft = this.resolveLeft(triggerRect, tooltipRect);
    const maxLeft = Math.max(TOOLTIP_MARGIN, viewportWidth - tooltipRect.width - TOOLTIP_MARGIN);
    const left = clamp(unclampedLeft, TOOLTIP_MARGIN, maxLeft);
    const rawTop =
      preferredPlacement === "bottom"
        ? triggerRect.bottom + TOOLTIP_GAP
        : triggerRect.top - tooltipRect.height - TOOLTIP_GAP;
    const maxTop = Math.max(TOOLTIP_MARGIN, viewportHeight - tooltipRect.height - TOOLTIP_MARGIN);
    const top = clamp(rawTop, TOOLTIP_MARGIN, maxTop);
    const triggerCenter = triggerRect.left + triggerRect.width / 2;
    const arrowMax = Math.max(TOOLTIP_ARROW_MIN, tooltipRect.width - TOOLTIP_ARROW_MIN);
    this.position = {
      left: Math.round(left),
      top: Math.round(top),
      arrowLeft: Math.round(clamp(triggerCenter - left, TOOLTIP_ARROW_MIN, arrowMax)),
      placement: preferredPlacement,
    };
  }

  private resolvePlacement(
    triggerRect: DOMRect,
    tooltipRect: DOMRect,
    viewportHeight: number,
  ): TooltipPlacement {
    if (this.placement === "top") {
      const fitsTop = triggerRect.top - tooltipRect.height - TOOLTIP_GAP >= TOOLTIP_MARGIN;
      return fitsTop ? "top" : "bottom";
    }
    const fitsBottom =
      triggerRect.bottom + tooltipRect.height + TOOLTIP_GAP <= viewportHeight - TOOLTIP_MARGIN;
    return fitsBottom ? "bottom" : "top";
  }

  private resolveLeft(triggerRect: DOMRect, tooltipRect: DOMRect): number {
    if (this.align === "start") {
      return triggerRect.left;
    }
    if (this.align === "end") {
      return triggerRect.right - tooltipRect.width;
    }
    return triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

if (!customElements.get("openclaw-tooltip")) {
  customElements.define("openclaw-tooltip", OpenClawTooltip);
}
