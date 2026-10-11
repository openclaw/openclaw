import type { nothing, TemplateResult } from "lit";

export type PanelTabStripTab = {
  id: string;
  domId: string;
  label: string;
  labelTooltip?: string | null;
  title?: string | null;
  icon?: TemplateResult | typeof nothing | null;
  statusLabel?: string | null;
  /** Short ownership marker (e.g. "agent") rendered as a pill after the label. */
  badge?: string | null;
  className?: string;
  closeLabel: string;
  group?: string;
  draggable?: boolean;
  reorderId?: string;
  /** Explicit click/Enter/Space action; arrow-key selection still uses onSelect. */
  onActivate?: () => void;
};

export type PanelTabStripParams<T extends PanelTabStripTab = PanelTabStripTab> = {
  tabs: T[];
  activeId: string | null;
  ariaControls: string | ((tab: T) => string);
  onSelect: (id: string) => void;
  onClose: (id: string) => void | Promise<void>;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
  newTabAction?: boolean;
  newControl?: TemplateResult | typeof nothing;
  separateTabs?: boolean;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
};
