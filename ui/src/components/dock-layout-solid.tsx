import { Show } from "solid-js";
import type { DockLayoutController } from "./dock-layout-controller.ts";
import type { DockPanelPlacement } from "./dock-panel-layout.ts";
import "./panel-elements.ts";
import "./resizable-divider.ts";

export function DockResizer<TDock extends DockPanelPlacement>(props: {
  controller: DockLayoutController<TDock>;
  classPrefix: string;
  label: string;
}) {
  return (
    <Show when={props.controller.resizer}>
      {(resizer) => (
        <resizable-divider
          class={`${props.classPrefix}-resizer ${props.classPrefix}-resizer--${props.controller.dock}`}
          prop:orientation={resizer().orientation}
          prop:label={props.label}
          prop:splitRatio={resizer().splitRatio}
          prop:minRatio={resizer().minRatio}
          prop:maxRatio={resizer().maxRatio}
          prop:measureRatio={resizer().measureRatio}
          prop:measureSize={resizer().measureSize}
          onResize={(event: CustomEvent<{ splitRatio: number }>) => props.controller.resize(event)}
          onResize-end={() => props.controller.persist()}
        />
      )}
    </Show>
  );
}
