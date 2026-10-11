import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { emptyLegacyContent, type LegacyTemplateResult } from "../../../lit/solid-content.tsx";
import type { SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelDefinition = {
  slot: SidebarSlotId;
  label: string;
  icon: LegacyTemplateResult;
  shortcut?: KeyboardShortcutCombo;
  available: boolean;
  content: LegacyTemplateResult | typeof emptyLegacyContent | null;
  loading: LegacyTemplateResult;
  headerAction?: LegacyTemplateResult;
  empty: {
    description: string;
    action?: LegacyTemplateResult;
  };
};

export type SidebarRegionCallbacks = {
  activatePanel: (panelId: string) => void;
  togglePanelExpanded: (panelId: string) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  openSlot: (slot: SidebarSlotId) => void;
  reorderPanel: (panelId: string, targetPanelId: string, placement: "before" | "after") => void;
  resizePanel: (columnId: string, size: number) => void;
  setOpen: (open: boolean) => void;
};
