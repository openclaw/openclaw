// Tailscale exposure tests cover serve/funnel enablement, preserve-funnel mode,
// hostname discovery, cleanup handles, warning paths, and pre-cleanup of stale
// serve entries on startup.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enableTailscaleServe: vi.fn(async (_port: number) => undefined),
  disableTailscaleServe: vi.fn(async () => undefined),
  enableTailscaleFunnel: vi.fn(async (_port: number) => undefined),
  disableTailscaleFunnel: vi.fn(async () => undefined),
  getTailnetHostname: vi.fn<() => Promise<string | null>>(async () => null),
  hasTailscaleFunnelRouteForPort: vi.fn(async (_port: number) => false),
}));

vi.mock("../infra/tailscale.js", () => ({
  enableTailscaleServe: mocks.enableTailscaleServe,
  disableTailscaleServe: mocks.disableTailscaleServe,
  enableTailscaleFunnel: mocks.enableTailscaleFunnel,
  disableTailscaleFunnel: mocks.disableTailscaleFunnel,
  getTailnetHostname: mocks.getTailnetHostname,
  hasTailscaleFunnelRouteForPort: mocks.hasTailscaleFunnelRouteForPort,
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
});

describe("startGatewayTailscaleExposure preserveFunnel", () => {
  it("pre-cleans stale serve routes before enabling", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    // disableTailscaleServe must be called before enableTailscaleServe
    expect(mocks.disableTailscaleServe).toHaveBeenCalled();
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
    const disableOrder = mocks.disableTailscaleServe.mock.invocationCallOrder[0];
    const enableOrder = mocks.enableTailscaleServe.mock.invocationCallOrder[0];
    expect(disableOrder).toBeLessThan(enableOrder);
  });

  it("pre-cleanup failure does not block serve enable", async () => {
    const logTailscale = createLogger();
    mocks.disableTailscaleServe.mockRejectedValueOnce(new Error("tailscale not running"));

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
    // No serve failure logged since cleanup is best-effort
    expect(logTailscale.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("serve failed"),
    );
  });

  it("pre-cleans using serviceName when configured", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).toHaveBeenCalledWith(undefined, "svc:openclaw");
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
  });

  it("does not pre-clean in funnel mode", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789);
  });

  it("does not pre-clean when preserveFunnel skips serve", async () => {
    const logTailscale = createLogger();
    mocks.hasTailscaleFunnelRouteForPort.mockResolvedValue(true);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
  });

  it("calls enableTailscaleServe in serve mode when preserveFunnel is unset", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).toHaveBeenCalled();
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
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

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info.mock.calls).toEqual([
      ["serve skipped: preserving externally configured Tailscale Funnel for port 18789"],
    ]);
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
    expect(logTailscale.info.mock.calls).toEqual([
      [
        "serve skipped: preserving externally configured Tailscale Funnel for port 18789; resetOnExit is a no-op because no Serve route was applied this run",
      ],
    ]);
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

    expect(mocks.hasTailscaleFunnelRouteForPort).toHaveBeenCalledWith(18789);
    expect(mocks.disableTailscaleServe).toHaveBeenCalled();
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789);
  });

  it("passes serviceName through to Tailscale Serve setup and cleanup", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      resetOnExit: true,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).toHaveBeenCalledWith(undefined, "svc:openclaw");
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
    expect(logTailscale.info).toHaveBeenCalledWith(
      "serve enabled for svc:openclaw: https://openclaw.tailnet.ts.net/ (WS via wss://openclaw.tailnet.ts.net)",
    );

    await cleanup?.();

    // Called twice: once for pre-cleanup, once for shutdown cleanup
    expect(mocks.disableTailscaleServe).toHaveBeenCalledTimes(2);
  });

  it("does not use serviceName in funnel mode", async () => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue("node.tailnet.ts.net");

    const cleanup = await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      resetOnExit: true,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789);
    expect(mocks.enableTailscaleServe).not.toHaveBeenCalled();
    expect(logTailscale.info).toHaveBeenCalledWith(
      "funnel enabled: https://node.tailnet.ts.net/ (WS via wss://node.tailnet.ts.net)",
    );

    await cleanup?.();

    expect(mocks.disableTailscaleFunnel).toHaveBeenCalledWith();
    expect(mocks.disableTailscaleServe).not.toHaveBeenCalled();
  });

  it.each([
    ["only reports an IP", "100.64.0.8"],
    ["omits the DNS suffix", "node"],
  ])("does not derive a Service URL when Tailscale %s", async (_name, hostname) => {
    const logTailscale = createLogger();
    mocks.getTailnetHostname.mockResolvedValue(hostname);

    await startGatewayTailscaleExposure({
      tailscaleMode: "serve",
      port: 18789,
      serviceName: "svc:openclaw",
      logTailscale,
    });

    expect(mocks.disableTailscaleServe).toHaveBeenCalledWith(undefined, "svc:openclaw");
    expect(mocks.enableTailscaleServe).toHaveBeenCalledWith(18789, undefined, "svc:openclaw");
    expect(logTailscale.info).toHaveBeenCalledWith("serve enabled");
  });

  it("never consults the Funnel route helper when running in funnel mode", async () => {
    const logTailscale = createLogger();

    await startGatewayTailscaleExposure({
      tailscaleMode: "funnel",
      port: 18789,
      preserveFunnel: true,
      logTailscale,
    });

    expect(mocks.hasTailscaleFunnelRouteForPort).not.toHaveBeenCalled();
    expect(mocks.enableTailscaleFunnel).toHaveBeenCalledWith(18789);
  });
});
