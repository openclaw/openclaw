import { afterEach, describe, expect, it } from "vitest";
import { describeGatewayServiceRestart, resolveGatewayService } from "./service.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform | "aix") {
  if (!originalPlatformDescriptor) {
    throw new Error("missing process.platform descriptor");
  }
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatformDescriptor.enumerable ?? false,
    value,
  });
}

afterEach(() => {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
});

describe("resolveGatewayService", () => {
  it.each([
    { platform: "darwin" as const, label: "LaunchAgent", loadedText: "loaded" },
    { platform: "linux" as const, label: "systemd", loadedText: "enabled" },
    { platform: "win32" as const, label: "Scheduled Task", loadedText: "registered" },
  ])("returns the registered adapter for $platform", ({ platform, label, loadedText }) => {
    setPlatform(platform);
    const service = resolveGatewayService();
    expect(service.label).toBe(label);
    expect(service.loadedText).toBe(loadedText);
  });

  it("throws for unsupported platforms", () => {
    setPlatform("aix");
    expect(() => resolveGatewayService()).toThrow("Gateway service install not supported on aix");
  });

  it("describes scheduled restart handoffs consistently", () => {
    expect(describeGatewayServiceRestart("Gateway", { outcome: "scheduled" })).toEqual({
      scheduled: true,
      daemonActionResult: "scheduled",
      message: "restart scheduled, gateway will restart momentarily",
      progressMessage: "Gateway service restart scheduled.",
    });
  });
});
