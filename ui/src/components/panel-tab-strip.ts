import { html, nothing, render as renderLit, unsafeCSS, type TemplateResult } from "lit";
import { Directive, directive, type Part } from "lit/directive.js";
import { panelTabStripCss } from "./panel-tab-strip-styles.ts";
import "./panel-tab-strip-lit.tsx";
import type {
  LegacyPanelTabStripParams,
  PanelTabStripParams as BasePanelTabStripParams,
  PanelTabStripTab as BasePanelTabStripTab,
} from "./panel-tab-strip-types.ts";

export type PanelTabStripTab = BasePanelTabStripTab<TemplateResult | Node | typeof nothing>;
export type PanelTabStripParams<T extends PanelTabStripTab = PanelTabStripTab> =
  BasePanelTabStripParams<T, TemplateResult | Node | typeof nothing>;

type LegacyInputs = Omit<LegacyPanelTabStripParams, "renderContent">;

function shallowEqual(left: object, right: object) {
  const entries: [string, unknown][] = Object.entries(left);
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

export const panelTabStripStyles = unsafeCSS(panelTabStripCss);
