import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";

export function requestDebugOverlayToggle(): void {
  window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
}
