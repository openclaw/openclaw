import type { GatewayStatus } from "../lib/gateway-status.ts";

export function canRetryGatewayStatus(kind: GatewayStatus | "connected" | null): boolean {
  return kind === "offline";
}

export type GatewayStatusProps = {
  kind: GatewayStatus | "connected" | null;
  lastError?: string | null;
  onRetry?: () => void;
  queuedCount?: number;
  announce?: boolean;
};
