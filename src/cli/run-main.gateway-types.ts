import type { runRemoteGatewayInferenceOnboarding } from "../commands/onboard-remote-gateway.js";

export type GatewayLaunchTarget = Parameters<typeof runRemoteGatewayInferenceOnboarding>[0];

export type BareRootLaunchTarget =
  | { kind: "onboarding"; classic?: boolean }
  | { kind: "remote-gateway-inference"; target: GatewayLaunchTarget }
  | { kind: "tui"; local: true }
  | ({ kind: "tui"; local: false } & GatewayLaunchTarget);

export type GatewayProbeTarget = {
  url: string;
  scope: "local-loopback" | "local-configured" | "remote";
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

export type ReachableGateway = {
  url: string;
  remote: boolean;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

export type GatewayResolution =
  | { kind: "configured"; gateway: ReachableGateway }
  | { kind: "missing-configured-model"; gateway: ReachableGateway }
  | { kind: "reachable-unverified"; gateway: ReachableGateway }
  | { kind: "configured-unreachable"; gateway: ReachableGateway }
  | { kind: "unreachable" };

export type GatewayProbeAuth = {
  token?: string;
  password?: string;
};
