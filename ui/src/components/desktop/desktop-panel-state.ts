export type DesktopPanelState =
  | "picker"
  | "inventory-error"
  | "credentials"
  | "connecting"
  | "connected"
  | "disconnected";

export type DesktopSizingMode = "fit" | "actual" | "fit-height" | "fit-width" | "focus" | "match";

/** Fractions of the current RFB framebuffer, retained across control handoffs. */
export type DesktopFocusRegion = Readonly<{ x: number; y: number; width: number; height: number }>;
