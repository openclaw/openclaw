export type PanelTabStripTab<Content = unknown> = {
  id: string;
  domId: string;
  label: string;
  labelTooltip?: string | null;
  title?: string | null;
  icon?: Content | null;
  statusLabel?: string | null;
  /** Short ownership marker (e.g. "agent") rendered as a pill after the label. */
  badge?: string | null;
  className?: string;
  closeLabel: string;
  closeDisabled?: boolean;
  group?: string;
  draggable?: boolean;
  reorderId?: string;
  /** Explicit click/Enter/Space action; arrow-key selection still uses onSelect. */
  onActivate?: () => void;
};
