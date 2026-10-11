import { Show, createEffect, createMemo, mapArray, merge, omit, onCleanup } from "solid-js";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { PanelTabStrip } from "./panel-tab-strip-solid.tsx";
import type {
  LegacyPanelTabStripParams,
  PanelTabStripContentRenderer,
} from "./panel-tab-strip-types.ts";

/** The callback owns this leaf's descendants; Solid owns the surrounding tab UI. */
function LitContent(props: { value: unknown; renderContent: PanelTabStripContentRenderer }) {
  let container!: HTMLSpanElement;
  let renderContent: PanelTabStripContentRenderer | undefined;
  const content = createMemo(() => ({ value: props.value, renderContent: props.renderContent }), {
    equals: (before, after) =>
      before.value === after.value && before.renderContent === after.renderContent,
  });
  createEffect(content, (next) => {
    renderContent = next.renderContent;
    renderContent(next.value, container);
  });
  onCleanup(() => {
    renderContent?.(undefined, container);
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

function LegacyPanelTabStrip(props: { params: LegacyPanelTabStripParams }) {
  const tabs = mapArray(
    () => props.params.tabs,
    (tab) => {
      const icon = <LitContent value={tab().icon} renderContent={props.params.renderContent} />;
      return merge(omit(merge(tab), "icon"), {
        get icon() {
          return tab().icon === undefined ? undefined : icon;
        },
      });
    },
    { keyed: (tab) => tab.id },
  );
  // Keep interactive caller content in the same Lit root across tab updates.
  const newControl = (
    <LitContent
      value={props.params.newControl ?? undefined}
      renderContent={props.params.renderContent}
    />
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
        props.params.newControl === null ? null : props.params.newControl ? newControl : undefined
      }
      separateTabs={props.params.separateTabs}
      onReorder={props.params.onReorder}
    />
  );
}

defineSolidBridge<{ params: LegacyPanelTabStripParams | null }>(
  "openclaw-panel-tab-strip",
  (props) => (
    <Show when={props.params}>{(params) => <LegacyPanelTabStrip params={params()} />}</Show>
  ),
  { properties: { params: { default: null, attribute: false } } },
);
