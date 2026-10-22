import { onSettled } from "solid-js";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  SIDEBAR_MIN_HEIGHT_PX,
  SIDEBAR_MIN_WIDTH_PX,
  sidebarDock,
  type SidebarColumn,
} from "../sidebar-layout.ts";
import type { RegionProps } from "./chat-sidebar-region-types.ts";

type SidebarRegionDividerProps = Pick<
  RegionProps,
  "elements" | "layout" | "availableWidth" | "callbacks"
> & {
  column: SidebarColumn;
  panelElements: ReadonlyMap<string, HTMLDivElement>;
  host: HTMLElement;
};

export function SidebarRegionDivider(props: SidebarRegionDividerProps) {
  const resizeCommit = {};
  const finishResize = () => {
    scheduleLayout(resizeCommit, () => {
      const shell = props.elements?.shell;
      // Settle the direct resize before re-enabling frame transitions.
      shell?.getBoundingClientRect();
      return () => shell?.removeAttribute("data-sidebar-resizing");
    });
  };
  const beginResize = () => {
    const shell = props.elements?.shell;
    if (shell?.classList.contains("sidebar-region--desktop")) {
      shell.setAttribute("data-sidebar-resizing", "");
    }
  };
  onSettled(() => () => {
    cancelLayout(resizeCommit);
    props.elements?.shell.removeAttribute("data-sidebar-resizing");
  });
  const dock = () => sidebarDock(props.layout);
  const dimension = () => (dock() === "bottom" ? "height" : "width");
  const measure = () => {
    const shell = props.elements?.shell;
    const surfaces = [props.elements?.primary, ...props.panelElements.values()];
    const primary = surfaces.find((element) => element?.dataset.region === "main");
    const panel = surfaces.find((element) => element?.dataset.region === "side" && !element.hidden);
    const primarySize = primary?.getBoundingClientRect()[dimension()] ?? 0;
    const panelSize = panel?.getBoundingClientRect()[dimension()] ?? props.column[dimension()];
    // Grid columns mirror in RTL; divider ratios follow physical left/top movement.
    const panelBeforeMain =
      dock() !== "bottom" &&
      (dock() === "left") !== (getComputedStyle(shell ?? props.host).direction === "rtl");
    return { primarySize, panelSize, panelBeforeMain, total: primarySize + panelSize };
  };
  return (
    <resizable-divider
      class="sidebar-column__divider"
      prop:label={t("chat.sidePanel.resize")}
      prop:orientation={dock() === "bottom" ? "horizontal" : "vertical"}
      prop:splitRatio={0.5}
      prop:minRatio={0.05}
      prop:maxRatio={0.95}
      prop:measureRatio={() => {
        const { primarySize, panelSize, panelBeforeMain, total } = measure();
        return total > 0 ? (panelBeforeMain ? panelSize : primarySize) / total : 0.5;
      }}
      prop:measureSize={() => measure().total}
      onResize-start={beginResize}
      onResize-end={finishResize}
      onResize={(event: CustomEvent<{ splitRatio: number }>) => {
        // Keyboard resize emits resize/end without a pointer resize-start.
        beginResize();
        const bounds = props.elements?.shell.getBoundingClientRect();
        const regionSize =
          dimension() === "width" && props.availableWidth > 0
            ? props.availableWidth
            : (bounds?.[dimension()] ?? 0);
        const measured = measure();
        const total = measured.total || regionSize;
        const requested =
          total *
          (measured.panelBeforeMain ? event.detail.splitRatio : 1 - event.detail.splitRatio);
        const minimum = dock() === "bottom" ? SIDEBAR_MIN_HEIGHT_PX : SIDEBAR_MIN_WIDTH_PX;
        const maximum = Math.max(minimum, regionSize * 0.6);
        props.callbacks?.resizePanel(
          props.column.id,
          Math.max(minimum, Math.min(requested, maximum)),
        );
      }}
    />
  );
}
