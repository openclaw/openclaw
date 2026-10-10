import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { DashboardPreview, type DashboardPreviewProps } from "./dashboard-preview.tsx";

defineSolidBridge<DashboardPreviewProps>("openclaw-dashboard-preview", DashboardPreview, {
  properties: {
    gatewaySnapshot: { default: undefined, attribute: false },
    sessionKey: { default: "", attribute: false },
    agentId: { default: undefined, attribute: false },
    error: { default: null, attribute: false },
  },
});
