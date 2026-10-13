import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { DashboardPreviewContent, type DashboardPreviewProps } from "./dashboard-preview.tsx";

export const DashboardPreview = defineSolidBridge<DashboardPreviewProps>(
  "openclaw-dashboard-preview",
  DashboardPreviewContent,
  {
    properties: {
      gatewaySnapshot: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      agentId: { default: undefined, attribute: false },
      error: { default: null, attribute: false },
    },
  },
);
