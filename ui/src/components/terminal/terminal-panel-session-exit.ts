import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  announceCatalogSessionReleased,
  type CatalogSessionReleasedDetail,
} from "../../lib/sessions/catalog-key.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";

export type TerminalCatalogRelease = Omit<CatalogSessionReleasedDetail, "agentId"> & {
  agentId: string | null;
};

export function applyTerminalExit(
  tab: TerminalPanelSessionTab,
  info: { reason?: string; exitCode: number | null; signal?: number | null; error?: string },
  release?: TerminalCatalogRelease,
): string | null {
  delete tab.pendingOpen;
  tab.status = "exited";
  tab.exitReason = info.reason;
  tab.exitCode = info.exitCode;
  tab.exitSignal = info.signal;
  const releasedAgentId = tab.agentId?.trim() || release?.agentId?.trim();
  if (release && releasedAgentId) {
    announceCatalogSessionReleased({ ...release, agentId: releasedAgentId });
  }
  return info.error?.trim() ? formatUiExternalText(info.error) : null;
}
