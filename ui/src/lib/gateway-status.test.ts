// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  resolveGatewayStatus,
  type GatewayStatus,
  type GatewayStatusSnapshot,
} from "./gateway-status.ts";

const connected: GatewayStatusSnapshot = {
  phase: "connected",
  offlineStable: false,
  client: { recoveryScopeReady: true },
};

describe("gateway status", () => {
  it.each([
    {
      name: "a required refresh over an expected restart",
      snapshot: { restartPending: true, suspensionPhase: "prepared" },
      refreshRequired: true,
      expected: "reload-required",
    },
    {
      name: "a rejected build over an expected restart",
      snapshot: { phase: "reload-required", restartPending: true },
      expected: "reload-required",
    },
    {
      name: "an expected restart over startup and a held suspension",
      snapshot: { phase: "starting", restartPending: true, suspensionPhase: "prepared" },
      expected: "restarting",
    },
    {
      name: "preparation while the socket remains connected",
      snapshot: { suspensionPhase: "preparing" },
      expected: "suspending",
    },
    {
      name: "draining while the socket reconnects",
      snapshot: { phase: "reconnecting", offlineStable: true, suspensionPhase: "draining" },
      expected: "suspending",
    },
    {
      name: "a held suspension over an initial connection",
      snapshot: { phase: "connecting", suspensionPhase: "prepared" },
      expected: "suspended",
    },
  ] satisfies Array<{
    name: string;
    snapshot: Partial<GatewayStatusSnapshot>;
    refreshRequired?: boolean;
    expected: GatewayStatus;
  }>)("prioritizes $name", ({ snapshot, refreshRequired, expected }) => {
    expect(resolveGatewayStatus({ ...connected, ...snapshot }, refreshRequired)).toBe(expected);
  });

  it.each(["connecting", "starting"] as const)(
    "shows %s before the offline grace period expires",
    (phase) => {
      expect(resolveGatewayStatus({ ...connected, phase, client: null })).toBe(phase);
    },
  );

  it.each([
    { phase: "reconnecting", expected: "reconnecting" },
    { phase: "offline", expected: "offline" },
    { phase: "stopped", expected: "offline" },
  ] as const)("waits for the offline grace period in $phase", ({ phase, expected }) => {
    const snapshot: GatewayStatusSnapshot = { ...connected, phase, client: null };
    expect(resolveGatewayStatus(snapshot)).toBeNull();
    expect(resolveGatewayStatus({ ...snapshot, offlineStable: true })).toBe(expected);
  });

  it("keeps restored transport visible until its recovery scope is ready", () => {
    const snapshot: GatewayStatusSnapshot = {
      ...connected,
      offlineStable: true,
      suspensionPhase: "accepting",
      client: { recoveryScopeReady: false },
    };
    expect(resolveGatewayStatus(snapshot)).toBe("restoring");
    expect(resolveGatewayStatus({ ...snapshot, client: { recoveryScopeReady: true } })).toBeNull();
  });

  it("does not infer restoration from a missing client", () => {
    expect(resolveGatewayStatus({ ...connected, client: null })).toBeNull();
  });
});
