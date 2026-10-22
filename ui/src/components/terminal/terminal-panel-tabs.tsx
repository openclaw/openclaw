import { t } from "../../i18n/index.ts";
import type { PanelHostedTab } from "../panel-hosted-tabs.ts";
import { StrokeIcon } from "../solid/stroke-icon.tsx";

export type TerminalPanelTab = {
  id: string;
  sequence: number;
  shellName: string | null;
  agentId: string | null;
  cwd: string | null;
  status: "connecting" | "live" | "exited";
  exitReason?: string;
  exitCode?: number | null;
  exitSignal?: number | null;
  /** Set for PTYs an agent opened; surfaces an "agent" pill on the tab. */
  agentOwned?: boolean;
};

export function terminalPanelTabIcon() {
  return (
    <StrokeIcon viewBox="0 0 16 16" width="13" height="13" stroke-width="1.4">
      <path d="M3 4l3 3-3 3M8 11h5" />
    </StrokeIcon>
  );
}

function terminalTabStatusLabel(tab: TerminalPanelTab): string | null {
  if (tab.status === "connecting") {
    return t("terminal.connecting");
  }
  if (tab.status !== "exited") {
    return null;
  }
  if (tab.exitReason === "detached") {
    return t("terminal.detached");
  }
  if (typeof tab.exitSignal === "number" && tab.exitSignal > 0) {
    return t("terminal.exitedSignal", { signal: String(tab.exitSignal) });
  }
  return tab.exitReason === "process_exit" && typeof tab.exitCode === "number"
    ? t("terminal.exitedCode", { code: String(tab.exitCode) })
    : t("terminal.exited");
}

export function terminalPanelHostedTabs(
  tabs: TerminalPanelTab[],
  connected: boolean,
): PanelHostedTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    label: tab.shellName ?? t("terminal.tabLabel", { n: String(tab.sequence) }),
    title:
      tab.agentId === null || tab.cwd === null
        ? null
        : t("terminal.tabHint", { agent: tab.agentId, cwd: tab.cwd }),
    statusLabel: terminalTabStatusLabel(tab),
    badge: tab.agentOwned ? t("terminal.agentOwnedBadge") : null,
    className: `is-${tab.status}`,
    closeDisabled: !connected && tab.status !== "exited",
  }));
}
