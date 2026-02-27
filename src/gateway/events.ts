import type { getUpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: ReturnType<typeof getUpdateAvailable>;
};
