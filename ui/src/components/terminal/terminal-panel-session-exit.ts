import { announceCatalogSessionReleased } from "../../lib/sessions/catalog-key.ts";
import type {
  TerminalPanelOpenAction,
  TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";

export type TerminalExitInfo = {
  reason?: string;
  exitCode: number | null;
  signal?: number | null;
  error?: string;
};

/** Applies the authoritative exit snapshot before releasing a native catalog reader. */
export function applyTerminalSessionExit(
  tab: TerminalPanelSessionTab,
  info: TerminalExitInfo,
  openAction?: TerminalPanelOpenAction,
): void {
  delete tab.pendingOpen;
  tab.status = "exited";
  tab.exitReason = info.reason;
  tab.exitCode = info.exitCode;
  tab.exitSignal = info.signal;
  const agentId = tab.agentId?.trim() || openAction?.agentId?.trim();
  if (openAction?.kind === "catalog" && agentId) {
    announceCatalogSessionReleased({ ...openAction.catalog, agentId });
  }
}
