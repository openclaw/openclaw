import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { COMMAND_PALETTE_OPEN_EVENT } from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { getSafeSessionStorage } from "../local-storage.ts";

const STORAGE_KEY = "openclaw:lazy-event";
export const SHELL_APPROVALS_OPEN_EVENT = "openclaw:approvals-open";
const eventTypes = [
  COMMAND_PALETTE_OPEN_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  SHELL_APPROVALS_OPEN_EVENT,
] as const;

export type LazyShellEvent = {
  eventType: (typeof eventTypes)[number];
  detail?: object;
};

export function lazyShellEvent(
  eventType: LazyShellEvent["eventType"],
  event?: Event,
): LazyShellEvent {
  const detail = event instanceof CustomEvent ? event.detail : null;
  return isRecord(detail) ? { eventType, detail } : { eventType };
}

export function readLazyShellAction(): LazyShellEvent | null {
  try {
    const stored = getSafeSessionStorage()?.getItem(STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (!isRecord(parsed) || !Object.hasOwn(parsed, "eventType")) {
      clearLazyShellAction();
      return null;
    }
    const keyCount = Object.keys(parsed).length;
    const eventType = eventTypes.find((candidate) => candidate === parsed.eventType);
    if (eventType && keyCount === 1) {
      return { eventType };
    }
    const detail = parsed.detail;
    if (eventType && keyCount === 2 && Object.hasOwn(parsed, "detail") && isRecord(detail)) {
      return { eventType, detail };
    }
  } catch {}
  clearLazyShellAction();
  return null;
}

export function persistLazyShellAction(event: LazyShellEvent): boolean {
  try {
    const storage = getSafeSessionStorage();
    if (!storage) {
      return false;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(event));
    return true;
  } catch {}
  // A failed replacement must not leave a superseded action to replay on reload.
  clearLazyShellAction();
  return false;
}

export function clearLazyShellAction(): void {
  try {
    getSafeSessionStorage()?.removeItem(STORAGE_KEY);
  } catch {}
}
