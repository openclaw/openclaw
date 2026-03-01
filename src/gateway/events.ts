import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_CONTROL_UI_I18N = "controlui.i18n" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayControlUiI18nEventPayload = {
  jobId: string;
  locale: string;
  status: "queued" | "running" | "completed" | "failed";
  requesterConnId?: string;
  error?: string;
  finishedAtMs?: number;
};
