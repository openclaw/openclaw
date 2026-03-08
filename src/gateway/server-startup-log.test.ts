import { describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
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

  it("does not warn about dangerous flags when config is clean", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const dangerousWarnings = warn.mock.calls
      .map((call) => call[0] as string)
      .filter((msg) => msg.includes("dangerous config flags"));
    expect(dangerousWarnings).toHaveLength(0);
  });

  it("logs all listen endpoints on a single line", () => {
    const info = vi.fn();
    const warn = vi.fn();

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

    // Empty config — no auth profiles, no env vars, no custom provider keys.
    // The default model (anthropic/claude-opus-4-6) has no auth available.
    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const authWarnings = warn.mock.calls
      .map((call) => call[0] as string)
      .filter((msg) => msg.includes("No auth configured for provider"));
    expect(authWarnings).toHaveLength(1);
    expect(authWarnings[0]).toContain("anthropic");
    expect(authWarnings[0]).toContain("openclaw auth login");
    expect(authWarnings[0]).toContain("openclaw models set");
  });

  it("does not warn about auth when the provider has a configured API key", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: "sk-test-key-12345",
              models: [{ id: "gpt-5.4", name: "GPT 5.4" }],
            },
          },
        },
      },
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const authWarnings = warn.mock.calls
      .map((call) => call[0] as string)
      .filter((msg) => msg.includes("No auth configured for provider"));
    expect(authWarnings).toHaveLength(0);
  });
});
