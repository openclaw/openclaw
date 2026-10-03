import type { StateLeaseProcessOwner } from "./state-lease-process-owner.js";

export type GatewayOwnerSupervisor = {
  kind: "launchd" | "systemd" | "schtasks" | "external";
  name: string | null;
};

export type GatewayOwnerLeaseIdentity = StateLeaseProcessOwner & {
  owner: string;
  port: number;
  mode: "foreground" | "supervised";
  supervisor: GatewayOwnerSupervisor | null;
  state: "live" | "dead" | "unknown";
  expired: boolean;
  heartbeatAt?: number;
};
