import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatewayService: {
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(),
    readCommand: vi.fn(),
    readRuntime: vi.fn(),
  },
  nodeService: {
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(),
    readCommand: vi.fn(),
    readRuntime: vi.fn(),
  },
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => mocks.gatewayService,
}));

vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.nodeService,
}));

import { getDaemonStatusSummary } from "./status.daemon.js";

describe("getDaemonStatusSummary", () => {
  beforeEach(() => {
    mocks.gatewayService.isLoaded.mockReset();
    mocks.gatewayService.readRuntime.mockReset();
    mocks.gatewayService.readCommand.mockReset();
  });

  it("treats a running service as installed even when command config cannot be read", async () => {
    mocks.gatewayService.isLoaded.mockResolvedValue(false);
    mocks.gatewayService.readCommand.mockResolvedValue(null);
    mocks.gatewayService.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });

    const summary = await getDaemonStatusSummary();

    expect(summary.installed).toBe(true);
    expect(summary.label).toBe("systemd");
  });

  it("treats a loaded service as installed even when command config cannot be read", async () => {
    mocks.gatewayService.isLoaded.mockResolvedValue(true);
    mocks.gatewayService.readCommand.mockResolvedValue(null);
    mocks.gatewayService.readRuntime.mockResolvedValue({ status: "stopped" });

    const summary = await getDaemonStatusSummary();

    expect(summary.installed).toBe(true);
    expect(summary.label).toBe("systemd");
  });

  it("keeps missing services as not installed", async () => {
    mocks.gatewayService.isLoaded.mockResolvedValue(false);
    mocks.gatewayService.readCommand.mockResolvedValue(null);
    mocks.gatewayService.readRuntime.mockResolvedValue({
      status: "stopped",
      missingUnit: true,
    });

    const summary = await getDaemonStatusSummary();

    expect(summary.installed).toBe(false);
  });
});
