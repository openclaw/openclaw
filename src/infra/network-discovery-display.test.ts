// Covers best-effort network discovery display helpers.
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  pickBestEffortPrimaryLanIPv4,
  pickBestEffortPrimaryTailnetIPv4,
  resolveBestEffortGatewayBindHostForDisplay,
} from "./network-discovery-display.js";

const discoveryErrorMessage = "uv_interface_addresses failed";

function mockInterfaceDiscoveryFailure(): void {
  vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
    throw new Error(discoveryErrorMessage);
  });
}

describe("network display discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no LAN address when interface discovery throws", () => {
    mockInterfaceDiscoveryFailure();

    expect(pickBestEffortPrimaryLanIPv4()).toBeUndefined();
  });

  it("returns no tailnet address when interface discovery throws", () => {
    mockInterfaceDiscoveryFailure();

    expect(pickBestEffortPrimaryTailnetIPv4()).toBeUndefined();
  });

  it("falls back to loopback when bind host resolution throws", async () => {
    mockInterfaceDiscoveryFailure();

    await expect(
      resolveBestEffortGatewayBindHostForDisplay({
        bindMode: "tailnet",
        warningPrefix:
          "Status is using fallback network details because interface discovery failed",
      }),
    ).resolves.toEqual({
      bindHost: "127.0.0.1",
      warning: `Status is using fallback network details because interface discovery failed: ${discoveryErrorMessage}.`,
    });
  });

  it("still returns discovered tailnet values when interfaces are available", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue(
      makeNetworkInterfacesSnapshot({
        utun9: [{ address: "100.88.1.5", family: "IPv4" }],
      }),
    );

    expect(pickBestEffortPrimaryTailnetIPv4()).toBe("100.88.1.5");
  });
});
