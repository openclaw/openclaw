import { describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveModelAuthMode: vi.fn().mockReturnValue(undefined),
}));

import { resolveModelAuthMode } from "../agents/model-auth.js";

describe("gateway startup log", () => {
  it("warns when dangerous config flags are enabled", () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.mocked(resolveModelAuthMode).mockReturnValue("api-key");

    logGatewayStartup({
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

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangerous config flags enabled"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
  });

  it("does not warn when dangerous config flags are disabled", () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.mocked(resolveModelAuthMode).mockReturnValue("api-key");

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs all listen endpoints on a single line", () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.mocked(resolveModelAuthMode).mockReturnValue("api-key");

    logGatewayStartup({
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

  it("warns when the default model provider has no auth configured", () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.mocked(resolveModelAuthMode).mockReturnValue("unknown");

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No auth configured for provider"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("will fail until credentials"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("setup-token"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("openclaw models set <provider/model>"),
    );
  });

  it("does not warn about auth when the provider has a configured API key", () => {
    const info = vi.fn();
    const warn = vi.fn();
    vi.mocked(resolveModelAuthMode).mockReturnValue("api-key");

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("No auth configured for provider"),
    );
  });
});
