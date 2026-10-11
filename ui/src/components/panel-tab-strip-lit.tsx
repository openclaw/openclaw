import { html, nothing, render as renderLit, type TemplateResult } from "lit";
import { Directive, directive, type Part } from "lit/directive.js";
import { Show, createEffect, createMemo, onCleanup } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { PanelTabStrip } from "./panel-tab-strip-solid.tsx";
import type { PanelTabStripParams, PanelTabStripTab } from "./panel-tab-strip-types.ts";

type LegacyTab = PanelTabStripTab & { controls: string };
type LegacyParams = Omit<PanelTabStripParams, "tabs" | "ariaControls"> & {
  tabs: LegacyTab[];
  renderHost?: object;
};

/** Preserve the originating Lit event/ref receiver inside the owned leaf roots. */
class RenderHostParamsDirective extends Directive {
  render(params: LegacyParams) {
    return params;
  }

  override update(part: Part, [params]: [LegacyParams]) {
    return { ...params, renderHost: part.options?.host };
  }
}

const withRenderHost = directive(RenderHostParamsDirective);

/** Lit owns only this leaf's descendants; Solid owns the surrounding tab UI. */
function LitContent(props: { value: TemplateResult | typeof nothing; host?: object }) {
  let container!: HTMLSpanElement;
  createEffect(
    () => ({ value: props.value, host: props.host }),
    ({ value, host }) => {
      renderLit(value, container, { host });
    },
  );
  onCleanup(() => {
    renderLit(nothing, container);
  });
  return (
    <span
      style={{ display: "contents" }}
      ref={(element) => {
        container = element;
      }}
    />
  );
}

function LegacyPanelTabStrip(props: { params: LegacyParams }) {
  const tabs = createMemo(() =>
    props.params.tabs.map((tab) => ({
      ...tab,
      icon:
        tab.icon == null || tab.icon === nothing ? undefined : (
          <LitContent value={tab.icon} host={props.params.renderHost} />
        ),
    })),
  );
  // Keep interactive caller content in the same Lit root across tab updates.
  const newControl = (
    <LitContent value={props.params.newControl ?? nothing} host={props.params.renderHost} />
  );
  return (
    <PanelTabStrip
      tabs={tabs()}
      activeId={props.params.activeId}
      ariaControls={(tab) => tab.controls}
      onSelect={props.params.onSelect}
      onClose={props.params.onClose}
      onNew={props.params.onNew}
      newLabel={props.params.newLabel}
      newDisabled={props.params.newDisabled}
      newTabAction={props.params.newTabAction}
      newControl={
        props.params.newControl === nothing
          ? null
          : props.params.newControl
            ? newControl
            : undefined
      }
      separateTabs={props.params.separateTabs}
      onReorder={props.params.onReorder}
    />
  );
}

defineSolidBridge<{ params: LegacyParams | null }>(
  "openclaw-panel-tab-strip",
  (props) => (
    <Show when={props.params}>{(params) => <LegacyPanelTabStrip params={params()} />}</Show>
  ),
  { properties: { params: { default: null, attribute: false } } },
);

/** Transitional adapter for the remaining Lit headers; the tab UI has one owner. */
export function renderPanelTabStrip<T extends PanelTabStripTab>(params: PanelTabStripParams<T>) {
  const bridgeParams: LegacyParams = {
    ...params,
    tabs: params.tabs.map((tab) => ({
      ...tab,
      controls:
        typeof params.ariaControls === "string" ? params.ariaControls : params.ariaControls(tab),
    })),
  };
  return html`<openclaw-panel-tab-strip
    style="display: contents"
    .params=${withRenderHost(bridgeParams)}
  ></openclaw-panel-tab-strip>`;
}
