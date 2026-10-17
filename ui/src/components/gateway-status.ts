import type { GatewayStatus } from "../lib/gateway-status.ts";

export function canRetryGatewayStatus(kind: GatewayStatus | null): boolean {
  return kind === "reconnecting" || kind === "offline";
}

export type GatewayStatusProps = {
  kind: GatewayStatus | null;
  lastError?: string | null;
  onRetry?: () => void;
  announce?: boolean;
};
