import { randomUUID } from "node:crypto";

let gatewayProcessInstanceId = randomUUID();

/** Stable for one Gateway process; changes across every restart, including PID reuse. */
export function getGatewayProcessInstanceId(): string {
  return gatewayProcessInstanceId;
}

/** Advance process-local ownership before an in-process Gateway restart recreates runtime state. */
export function rotateGatewayProcessInstanceId(): string {
  gatewayProcessInstanceId = randomUUID();
  return gatewayProcessInstanceId;
}
