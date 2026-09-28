import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { ApplicationContext } from "../app/context.ts";
import type { SwarmRosterHydrator } from "../lib/sessions/swarm-roster.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";

export type SwarmDiagnosticPane = HTMLElement & {
  state?: { sessionKey: string; connectionEpoch: number; lastError: string | null };
  swarmHydrator?: SwarmRosterHydrator;
};
export type SwarmDiagnosticWindow = Window & {
  openclawSwarmDiagnostic?: {
    expandedDetails?: Element | null;
    expandedEpoch?: number;
  };
};

export async function logSwarmDiagnostic(
  page: Page,
  gateway: MockGatewayControls,
  parentKey: string,
) {
  const state = await page.evaluate((key) => {
    const pane = document.querySelector<SwarmDiagnosticPane>(
      "openclaw-chat-pane.chat-pane-cache__pane--active",
    );
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { runtime?: { context?: ApplicationContext } })
      | null;
    const applicationGateway = app?.runtime?.context?.gateway;
    const snapshot = applicationGateway?.snapshot;
    const parent = pane?.swarmHydrator?.rows.find((row) => row.key === key);
    const widget = document.querySelector('[data-test-id="chat-swarm"]');
    const details = widget?.querySelector("details");
    const diagnostic = (window as SwarmDiagnosticWindow).openclawSwarmDiagnostic;
    return {
      sessionKey: pane?.state?.sessionKey,
      connectionEpoch: pane?.state?.connectionEpoch,
      expandedEpoch: diagnostic?.expandedEpoch,
      gatewayPhase: snapshot?.phase,
      lastErrorPresent: Boolean(snapshot?.lastError || pane?.state?.lastError),
      parent: parent && {
        status: parent.status,
        hasActiveRun: parent.hasActiveRun,
        updatedAt: parent.updatedAt,
      },
      detailsOpen: details?.open,
      detailsSame: details === diagnostic?.expandedDetails,
      outcome: widget?.querySelector(".chat-swarm__outcome")?.textContent?.trim(),
      events: applicationGateway?.eventLog.slice(0, 40).map(({ ts, event }) => ({ ts, event })),
    };
  }, parentKey);
  const requests = (await gateway.getRequests())
    .filter((request) => ["sessions.describe", "sessions.list"].includes(request.method))
    .slice(-30)
    .map(({ id, method, params }) => {
      const query = asNullableRecord(params);
      return { id, method, key: query?.key, spawnedBy: query?.spawnedBy, limit: query?.limit };
    });
  console.info("[swarm-final-diagnostic] " + JSON.stringify({ ...state, requests }));
}
