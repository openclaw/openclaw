import { describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  it("warns when dangerous config flags are enabled", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: {
            dangerouslyDisableDeviceAuth: true,
          },
        },
      },
      bindHost: "127.0.0.1",
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

  it("does not warn when dangerous config flags are disabled", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs all listen endpoints on a single line", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const listenMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("listening on "));
    expect(listenMessages).toEqual([
      `listening on ws://127.0.0.1:18789, ws://[::1]:18789 (PID ${process.pid})`,
    ]);
  });

  it("warns when gateway is exposed without auth at startup", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: { gateway: { bind: "lan", auth: { mode: "none" } } },
      bindHost: "0.0.0.0",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('security warning: CRITICAL: Gateway bound to "lan" (0.0.0.0)'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without authentication"));
  });

  it("suppresses startup exposure warning when override env is set", async () => {
    const previous = process.env.OPENCLAW_SKIP_AUTH_WARNING;
    process.env.OPENCLAW_SKIP_AUTH_WARNING = "true";
    const info = vi.fn();
    const warn = vi.fn();

    try {
      await logGatewayStartup({
        cfg: { gateway: { bind: "lan", auth: { mode: "none" } } },
        bindHost: "0.0.0.0",
        port: 18789,
        log: { info, warn },
        isNixMode: false,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_SKIP_AUTH_WARNING;
      } else {
        process.env.OPENCLAW_SKIP_AUTH_WARNING = previous;
      }
    }

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("without authentication"));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("gateway auth exposure warning suppressed"),
    );
  });
});
