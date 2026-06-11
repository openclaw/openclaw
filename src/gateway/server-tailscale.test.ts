import { afterEach, describe, expect, it, vi } from "vitest";
import type { TailscaleServeRouteVerification } from "../infra/tailscale.js";

const mocks = vi.hoisted(() => ({
  enableTailscaleServe: vi.fn(async (_port: number) => undefined),
  disableTailscaleServe: vi.fn(async () => undefined),
  enableTailscaleFunnel: vi.fn(async (_port: number) => undefined),
  disableTailscaleFunnel: vi.fn(async () => undefined),
  getTailnetHostname: vi.fn(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
  verifyTailscaleServeRouteForPort: vi.fn(
    async (_port: number): Promise<TailscaleServeRouteVerification> => ({ ok: true }),
  ),
}));

vi.mock("../infra/tailscale.js", () => ({
  enableTailscaleServe: mocks.enableTailscaleServe,
  disableTailscaleServe: mocks.disableTailscaleServe,
  enableTailscaleFunnel: mocks.enableTailscaleFunnel,
  disableTailscaleFunnel: mocks.disableTailscaleFunnel,
  getTailnetHostname: mocks.getTailnetHostname,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
  verifyTailscaleServeRouteForPort: mocks.verifyTailscaleServeRouteForPort,
}));

import { startGatewayTailscaleExposure } from "./server-tailscale.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

afterEach(() => {
  for (const fn of Object.values(mocks)) {
    fn.mockReset();
  }
  mocks.enableTailscaleServe.mockResolvedValue(undefined);
  mocks.disableTailscaleServe.mockResolvedValue(undefined);
  mocks.enableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.disableTailscaleFunnel.mockResolvedValue(undefined);
  mocks.getTailnetHostname.mockResolvedValue(null);
  mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);
  mocks.verifyTailscaleServeRouteForPort.mockResolvedValue({ ok: true });
});

describe("startGatewayTailscaleExposure preserveFunnel", () => {
  it("calls enableTailscaleServe in serve mode when preserveFunnel is unset", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
    expect(mocks.verifyTailscaleServeRouteForPort).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
  });

  it("skips enableTailscaleServe when preserveFunnel is true and a Funnel route covers the port", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(expect.stringMatching(/preserv/i));
  });

  it("notes resetOnExit is a no-op when preserveFunnel skips Serve", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      resetOnExit: true,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(
      expect.stringMatching(/resetOnExit is a no-op/i),
    );
  });

  it("falls back to enableTailscaleServe when preserveFunnel is true but no Funnel route exists for the port", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(false);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
  });

  it("verifies the Funnel route after enabling funnel mode", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789, undefined, {
      binaryPath: undefined,
      socketPath: undefined,
    });
  });

  it("throws when required serve exposure fails", async () => {
    const logTailscale = createLogger();
    mocks.enableTailscaleServe.mockRejectedValue(new Error("wrong socket"));

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale,
      }),
    ).rejects.toThrow(/required/);
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("wrong socket"));
  });

  it("keeps best-effort startup when required is false", async () => {
    const logTailscale = createLogger();
    mocks.enableTailscaleServe.mockRejectedValue(new Error("wrong socket"));

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        tailscaleConfig: { required: false },
        port: 18789,
        logTailscale,
      }),
    ).resolves.toBeNull();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringContaining("wrong socket"));
  });

  it("throws when required Serve route verification fails", async () => {
    const logTailscale = createLogger();
    mocks.verifyTailscaleServeRouteForPort.mockResolvedValue({
      ok: false,
      reason: "wrong backend",
    });

    await expect(
      startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        logTailscale,
      }),
    ).rejects.toThrow(/wrong backend/);
  });

  it("does not run broad Serve reset on shutdown", async () => {
    const logTailscale = createLogger();
    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      resetOnExit: true,
      logTailscale,
    });

    await cleanup?.();

    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledWith(expect.stringMatching(/serve reset/i));
  });
});
