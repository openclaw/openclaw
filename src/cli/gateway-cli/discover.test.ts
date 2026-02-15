import { describe, expect, it } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

describe("gateway discover routing helpers", () => {
  it("prefers resolved service host over TXT hints", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      lanHost: "evil.example.com",
      tailnetDns: "evil.example.com",
    };
    expect(pickBeaconHost(beacon)).toBe("10.0.0.2");
  });

  it("prefers resolved service port over TXT gatewayPort", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      gatewayPort: 12345,
    };
    expect(pickGatewayPort(beacon)).toBe(18789);
  });

  it("falls back to TXT host/port when resolve data is missing", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      lanHost: "test-host.local",
      gatewayPort: 18789,
    };
    expect(pickBeaconHost(beacon)).toBe("test-host.local");
    expect(pickGatewayPort(beacon)).toBe(18789);
  });
});
