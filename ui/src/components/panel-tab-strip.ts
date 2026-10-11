import { css, html, nothing, render as renderLit, type TemplateResult } from "lit";
import { Directive, directive, type Part } from "lit/directive.js";
import type {
  LegacyPanelTabStripParams,
  PanelTabStripParams as BasePanelTabStripParams,
  PanelTabStripTab as BasePanelTabStripTab,
} from "./panel-tab-strip-types.ts";
import "./panel-tab-strip-lit.tsx";

export type PanelTabStripTab = BasePanelTabStripTab<TemplateResult | typeof nothing>;
export type PanelTabStripParams<T extends PanelTabStripTab = PanelTabStripTab> =
  BasePanelTabStripParams<T, TemplateResult | Node | typeof nothing>;

type LegacyInputs = Omit<LegacyPanelTabStripParams, "renderContent">;

function shallowEqual(left: object, right: object) {
  const entries = Object.entries<unknown>(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => Object.is(value, Reflect.get(right, key)))
  );
}

/** Preserve the originating Lit event/ref receiver inside the owned leaf roots. */
class RenderHostParamsDirective extends Directive {
  private host?: object;
  private params?: LegacyPanelTabStripParams;
  private renderContent?: LegacyPanelTabStripParams["renderContent"];

  render(params: LegacyInputs) {
    return params;
  }

  override update(part: Part, [params]: [LegacyInputs]): LegacyPanelTabStripParams {
    const host = part.options?.host;
    if (!this.renderContent || this.host !== host) {
      this.host = host;
      this.renderContent = (value, container) => {
        renderLit(value ?? nothing, container, { host });
      };
    }
    const previousTabs = this.params?.tabs;
    const tabs = params.tabs.map((tab, index) => {
      const previous = previousTabs?.[index];
      return previous && shallowEqual(previous, tab) ? previous : tab;
    });
    const next = {
      ...params,
      tabs:
        previousTabs?.length === tabs.length &&
        tabs.every((tab, index) => tab === previousTabs[index])
          ? previousTabs
          : tabs,
      renderContent: this.renderContent,
    };
    if (!this.params || !shallowEqual(this.params, next)) {
      this.params = next;
    }
    return this.params;
  }
}

const withRenderHost = directive(RenderHostParamsDirective);

/** Transitional adapter for the remaining Lit headers; the tab UI has one owner. */
export function renderPanelTabStrip<T extends PanelTabStripTab>(params: PanelTabStripParams<T>) {
  const bridgeParams: LegacyInputs = {
    ...params,
    tabs: params.tabs.map((tab) => ({
      ...tab,
      icon: tab.icon == null || tab.icon === nothing ? undefined : tab.icon,
      controls:
        typeof params.ariaControls === "string" ? params.ariaControls : params.ariaControls(tab),
    })),
    newControl: params.newControl === nothing ? null : params.newControl,
  };
  return html`<openclaw-panel-tab-strip
    style="display: contents"
    .params=${withRenderHost(bridgeParams)}
  ></openclaw-panel-tab-strip>`;
}

export const panelTabStripStyles = css`
  :where(.tp-header, .bp-header) {
    --rail-header-height: 46px;
    --rail-header-padding-start: 8px;
  }
  :where(.tp-actions, .bp-actions) {
    padding-left: 8px;
    border-left: 1px solid var(--border, #262b34);
  }
  .tabstrip {
    --track-width: 0;
    display: block;
    /* Allow the strip to shrink inside a flex header so wide tab rows scroll
       here instead of squeezing out sibling header controls. */
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabstrip::part(nav) {
    display: flex;
    align-items: center;
  }
  .tabstrip::part(body) {
    display: none;
  }
  .tabstrip::-webkit-scrollbar {
    display: none;
  }
  .tabstrip-tab::part(base) {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 34px 0 10px;
    border: 0;
    border-radius: 7px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    transition:
      color 0.12s ease,
      background 0.12s ease,
      box-shadow 0.12s ease;
  }
  .tabstrip-tab:hover::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tabstrip-tab[active]::part(base) {
    color: var(--text, #d7dae0);
    background: var(--bg-hover, #1f2330);
    box-shadow: inset 0 0 0 1px var(--border-strong, #2e3040);
  }
  .tabstrip-tab.is-exited:not([active])::part(base) {
    opacity: 0.55;
  }
  .tabstrip-tab.is-connecting .tabstrip-tab__icon {
    animation: tabstrip-pulse 1.2s ease-in-out infinite;
  }
  .tabstrip-tab__icon {
    display: inline-flex;
    color: var(--accent, #ff5c5c);
  }
  .tabstrip-tab__favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    object-fit: contain;
  }
  .tabstrip-tab.is-exited .tabstrip-tab__icon {
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__label {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .tabstrip-tab__tooltip-trigger {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: inherit;
    flex: 1 1 auto;
  }
  .tabstrip-tab__status {
    font-size: 11px;
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__badge {
    border: 1px solid color-mix(in srgb, var(--accent, #ff5c5c) 45%, transparent);
    border-radius: 999px;
    color: var(--accent, #ff5c5c);
    font-size: 9px;
    line-height: 14px;
    padding: 0 5px;
    text-transform: uppercase;
  }
  /* Keep the close action inside the tab surface without nesting it in wa-tab;
     wa-tab-group still owns the direct tab children for keyboard navigation. */
  .tabstrip-tab__close {
    flex: 0 0 auto;
    align-self: center;
    z-index: 1;
    margin-left: -32px;
    margin-right: 4px;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .tabstrip-tab__close-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
  }
  :where(.tabstrip-tab:hover, .tabstrip-tab[active]) + .tabstrip-tab__close,
  .tabstrip-tab__close:hover,
  .tabstrip-tab__close:focus-visible {
    opacity: 1;
  }
  .tabstrip-new {
    flex: none;
    align-self: center;
    margin-left: 2px;
  }
  .tabstrip-new-control {
    display: inline-flex;
    flex: none;
    align-self: center;
  }
  .tabstrip-separator {
    flex: 0 0 auto;
    align-self: center;
  }
  @keyframes tabstrip-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tabstrip-tab.is-connecting .tabstrip-tab__icon {
      animation: none;
    }
  }
`;
