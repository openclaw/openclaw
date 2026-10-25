import { vi } from "vitest";
import type { SidebarRegionCallbacks } from "../pages/chat/components/chat-sidebar-region-types.ts";

export function createSidebarRegionCallbackMocks(overrides: Partial<SidebarRegionCallbacks> = {}) {
  return {
    activatePanel: overrides.activatePanel ?? vi.fn(),
    togglePanelExpanded: overrides.togglePanelExpanded ?? vi.fn(),
    setDock: overrides.setDock ?? vi.fn(),
    closeSlot: overrides.closeSlot ?? vi.fn(),
    openSlot: overrides.openSlot ?? vi.fn(),
    reorderPanel: overrides.reorderPanel ?? vi.fn(),
    resizePanel: overrides.resizePanel ?? vi.fn(),
    setOpen: overrides.setOpen ?? vi.fn(),
  };
}

export function createNoopSidebarRegionCallbacks(): SidebarRegionCallbacks {
  return {
    activatePanel() {},
    togglePanelExpanded() {},
    setDock() {},
    closeSlot() {},
    openSlot() {},
    reorderPanel() {},
    resizePanel() {},
    setOpen() {},
  };
}
