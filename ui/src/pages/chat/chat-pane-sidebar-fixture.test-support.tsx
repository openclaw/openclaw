import { vi } from "vitest";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { SidebarRegionView, type SidebarRegionViewProps } from "./chat-pane-sidebar-view.tsx";

export function sidebarCallbacks() {
  return {
    activatePanel: vi.fn(),
    togglePanelExpanded: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
}

export function SidebarFixture(
  props: Partial<SidebarRegionViewProps> & Pick<SidebarRegionViewProps, "layout">,
) {
  const panels = sidebarPanelDefinitions();
  const callbacks = sidebarCallbacks();
  return (
    <SidebarRegionView
      presentationId="sidebar-layout-fixture"
      panelIdPrefix={`chat-panel-${encodeURIComponent(props.presentationId ?? "sidebar-layout-fixture")}`}
      availableWidth={1400}
      narrow={false}
      callbacks={callbacks}
      panelDefinitions={panels}
      regionError={undefined}
      {...props}
    />
  );
}
