import { afterEach, describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns when dangerous config flags are enabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: {
            dangerouslyDisableDeviceAuth: true,
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangerous config flags enabled"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
  });

  it("does not warn when dangerous config flags are disabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when remote plain-HTTP Control UI will require secure context auth", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: { enabled: true },
        },
      },
      bindHost: "0.0.0.0",
      loadedPluginIds: [],
      port: 18789,
      tlsEnabled: false,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Control UI requires a secure browser context"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DEVICE_IDENTITY_REQUIRED"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
  });

  it("does not warn about Control UI secure context for loopback, TLS, disabled UI, or disabled device auth", () => {
    const cases = [
      { cfg: {}, bindHost: "127.0.0.1", tlsEnabled: false },
      { cfg: {}, bindHost: "0.0.0.0", tlsEnabled: true },
      {
        cfg: { gateway: { controlUi: { enabled: false } } },
        bindHost: "0.0.0.0",
        tlsEnabled: false,
      },
      {
        cfg: { gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } } },
        bindHost: "0.0.0.0",
        tlsEnabled: false,
      },
    ];

    for (const testCase of cases) {
      const info = vi.fn();
      const warn = vi.fn();
      logGatewayStartup({
        cfg: testCase.cfg,
        bindHost: testCase.bindHost,
        loadedPluginIds: [],
        port: 18789,
        tlsEnabled: testCase.tlsEnabled,
        log: { info, warn },
        isNixMode: false,
      });
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Control UI requires a secure browser context"),
      );
    }
  });

  it("logs a compact listening line with loaded plugin ids and duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:16.000Z"));

    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      loadedPluginIds: ["delta", "alpha", "delta", "beta"],
      port: 18789,
      startupStartedAt: Date.parse("2026-04-03T10:00:00.000Z"),
      log: { info, warn },
      isNixMode: false,
    });

    const listeningMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("http server listening ("));
    expect(listeningMessages).toEqual([
      "http server listening (3 plugins: alpha, beta, delta; 16.0s)",
    ]);
  });
});
