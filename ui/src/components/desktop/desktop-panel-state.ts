export type DesktopPanelState =
  | "picker"
  | "inventory-error"
  | "credentials"
  | "connecting"
  | "connected"
  | "disconnected";

export type DesktopSizingMode = "fit" | "actual" | "fit-height" | "fit-width" | "match";
