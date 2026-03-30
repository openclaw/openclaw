import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_UPDATE_PROGRESS = "update.progress" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayUpdateProgressEventPayload = {
  kind: "step.start" | "step.complete" | "finished";
  step?: {
    name: string;
    index: number;
    total: number;
  };
  completion?: {
    durationMs: number;
    exitCode: number | null;
  };
  result?: {
    status: "ok" | "error" | "skipped";
    reason?: string;
  };
};
