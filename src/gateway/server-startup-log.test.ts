import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { formatAgentModelStartupDetails, logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls).toEqual([
      [
        "security warning: dangerous config flags enabled: gateway.controlUi.dangerouslyDisableDeviceAuth=true. Run `openclaw security audit`.",
      ],
    ]);
  });

  it("does not warn when dangerous config flags are disabled", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs configured model thinking and fast mode defaults with the startup model", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            models: {
              "openai-codex/gpt-5.5": {
                params: {
                  fastMode: true,
                  thinking: "medium",
                },
              },
            },
            reasoningDefault: "stream",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const firstInfoCall = info.mock.calls[0];
    expect(firstInfoCall?.[0]).toBe("agent model: openai-codex/gpt-5.5 (thinking=medium, fast=on)");
    expect(stripAnsi(String(firstInfoCall?.[1]?.consoleMessage))).toBe(
      "agent model: openai-codex/gpt-5.5 (thinking=medium, fast=on)",
    );
  });

  it("defaults unset startup thinking to medium", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              model: "openai-codex/gpt-5.5",
            },
            list: [{ id: "main", default: true, fastModeDefault: true }],
          },
        },
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=medium, fast=on");
  });

  it("preserves explicit startup thinking off", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai-codex/gpt-5.5": { params: { thinking: "off", fastMode: true } },
              },
            },
          },
        },
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=off, fast=on");
  });

  it("shows thinking off for configured provider models with reasoning disabled", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          models: {
            providers: {
              google: {
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: [
                  {
                    id: "gemma-4-26b-a4b-it",
                    name: "Gemma 4 26B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        },
        provider: "google",
        model: "gemma-4-26b-a4b-it",
      }),
    ).toBe("thinking=off, fast=off");
  });

  it("uses default agent mode overrides in the startup model details", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              thinkingDefault: "low",
              reasoningDefault: "off",
              models: {
                "openai/gpt-5.5": { params: { fastMode: false } },
              },
            },
            list: [{ id: "alpha", default: true, thinkingDefault: "high", fastModeDefault: true }],
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=high, fast=on");
  });

  it("warns when remote plain-HTTP Control UI will require secure context auth", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
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

  it("uses resolved runtime state for Control UI secure context warnings", async () => {
    const disabledWarn = vi.fn();
    await logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: { enabled: true },
        },
      },
      bindHost: "0.0.0.0",
      loadedPluginIds: [],
      port: 18789,
      tlsEnabled: false,
      controlUiEnabled: false,
      log: { info: vi.fn(), warn: disabledWarn },
      isNixMode: false,
    });
    expect(disabledWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Control UI requires a secure browser context"),
    );

    const runtimeEnabledWarn = vi.fn();
    await logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: { enabled: false },
        },
      },
      bindHost: "0.0.0.0",
      loadedPluginIds: [],
      port: 18789,
      tlsEnabled: false,
      controlUiEnabled: true,
      log: { info: vi.fn(), warn: runtimeEnabledWarn },
      isNixMode: false,
    });
    expect(runtimeEnabledWarn).toHaveBeenCalledWith(
      expect.stringContaining("Control UI requires a secure browser context"),
    );

    const trustedProxyWarn = vi.fn();
    await logGatewayStartup({
      cfg: {},
      bindHost: "0.0.0.0",
      loadedPluginIds: [],
      port: 18789,
      tlsEnabled: false,
      controlUiEnabled: true,
      authMode: "trusted-proxy",
      log: { info: vi.fn(), warn: trustedProxyWarn },
      isNixMode: false,
    });
    expect(trustedProxyWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Control UI requires a secure browser context"),
    );
  });

  it("does not warn about Control UI secure context for loopback, TLS, trusted proxy, disabled UI, or disabled device auth", async () => {
    const cases = [
      { cfg: {}, bindHost: "127.0.0.1", tlsEnabled: false },
      { cfg: {}, bindHost: "0.0.0.0", tlsEnabled: true },
      {
        cfg: { gateway: { auth: { mode: "trusted-proxy" as const } } },
        bindHost: "0.0.0.0",
        tlsEnabled: false,
      },
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
      await logGatewayStartup({
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

  it("logs a compact listening line with loaded plugin ids and duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:16.000Z"));

    const info = vi.fn();
    const warn = vi.fn();

    await logGatewayStartup({
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
