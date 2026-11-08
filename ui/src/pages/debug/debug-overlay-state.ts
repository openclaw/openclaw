import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";

export type DebugOverlayMode = "expanded" | "minimized";

export type DebugOverlayElement = HTMLElement & {
  open: (mode: DebugOverlayMode) => void;
  toggle: () => void;
};

export function readDebugOverlayMode(
  event: { eventType: string; detail?: object } | null,
): DebugOverlayMode {
  return event?.eventType === DEBUG_OVERLAY_REQUEST_EVENT &&
    event.detail &&
    "mode" in event.detail &&
    event.detail.mode === "minimized"
    ? "minimized"
    : "expanded";
}

export function shouldCloseDebugOverlay(
  event: KeyboardEvent,
  mode: DebugOverlayMode | "closed",
  frame: EventTarget | null,
): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    mode !== "closed" &&
    (mode !== "minimized" || (frame !== null && event.composedPath().includes(frame)))
  );
}
