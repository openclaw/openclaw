import { hostname } from "node:os";

const refusalCode = "GATEWAY_RESTART_PREPARATION_REFUSED";
const failures = {
  "service-command": "Cannot verify the effective service command and state directory",
  "serving-owner": "Cannot verify a live serving Gateway owner for the selected service",
  "intent-recording": "Cannot record restart intent for the serving Gateway",
} as const;

export class GatewayRestartPreparationError extends Error {
  readonly code = refusalCode;

  constructor(
    readonly reason: keyof typeof failures,
    host?: string,
  ) {
    super(
      `${refusalCode}: ${failures[reason]}.${host && host !== hostname() ? ` Recorded serving host ${JSON.stringify(host)} does not match this host ${JSON.stringify(hostname())}.` : ""} Gateway was not signaled. Verify the service definition and Gateway status, then retry.`,
    );
    this.name = "GatewayRestartPreparationError";
  }
}
