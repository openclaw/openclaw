import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import type { RegionElement, RegionProps } from "./chat-sidebar-region-types.ts";

export function createSidebarRegionGeometry(
  host: RegionElement,
  props: RegionProps,
  panelElements: ReadonlyMap<string, HTMLDivElement>,
  panel: () => HTMLDivElement | undefined,
) {
  let previousGeometry = "";
  let stopPresentation = () => {};
  const presented = () => props.visualPresentation?.isPresented() !== false;
  const schedule = () => {
    if (!presented()) {
      cancelLayout(host);
      return;
    }
    scheduleLayout(host, () => {
      const elements = props.elements;
      if (!host.isConnected || !elements || !presented()) {
        return undefined;
      }
      const geometry = [
        elements.primary,
        ...(props.layout.columns[0]?.panels.flatMap((entry) => {
          const element = panelElements.get(entry.id);
          return element ? [element] : [];
        }) ?? []),
      ]
        .map(
          (content) =>
            `${content.dataset.panelSlot ?? "conversation"}:${content.getBoundingClientRect().width}`,
        )
        .join(":");
      // Compare content widths with the last visible commit, including role swaps.
      return () => {
        if (!presented()) {
          return;
        }
        panel()?.dispatchEvent(
          new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
            bubbles: true,
            detail: { widthChanged: geometry !== previousGeometry },
          }),
        );
        previousGeometry = geometry;
      };
    });
  };
  return {
    schedule,
    bindPresentation() {
      stopPresentation();
      const presentation = props.visualPresentation;
      stopPresentation = presentation
        ? listen(presentation.owner, PRESENTATION_CHANGED_EVENT, schedule)
        : () => {};
    },
    dispose() {
      stopPresentation();
      cancelLayout(host);
    },
  };
}
