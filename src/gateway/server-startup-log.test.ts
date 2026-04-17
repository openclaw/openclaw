import { afterEach, describe, expect, it, vi } from "vitest";
import { collectProxyEnvMismatch, logGatewayStartup } from "./server-startup-log.js";

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyConfigured: vi.fn(() => false),
}));

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

  it("logs a compact ready line with loaded plugin ids and duration", () => {
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

    const readyMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("ready ("));
    expect(readyMessages).toEqual(["ready (3 plugins: alpha, beta, delta; 16.0s)"]);
  });

  describe("proxy env mismatch warning", () => {
    it("warns when proxy env is set but remote providers lack proxy config", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      });

      expect(result).toContain("proxy env detected");
      expect(result).toContain("openai");
      expect(result).toContain("openrouter");
      expect(result).toContain("env-proxy");
    });

    it("does not warn when all remote providers have proxy configured", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              request: { proxy: { mode: "env-proxy" } },
              models: [],
            },
          },
        },
      });

      expect(result).toBeNull();
    });

    it("does not warn when no proxy env is set", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(false);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      });

      expect(result).toBeNull();
    });

    it("does not warn for local providers", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      });

      expect(result).toBeNull();
    });

    it("does not warn for providers with proxy-incapable APIs", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            ollama: {
              baseUrl: "https://remote-ollama.example.com",
              api: "ollama",
              models: [],
            },
          },
        },
      });

      expect(result).toBeNull();
    });

    it("does not warn for RFC 1918 private LAN providers", async () => {
      const { hasEnvHttpProxyConfigured } = await import("../infra/net/proxy-env.js");
      vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

      const result = collectProxyEnvMismatch({
        models: {
          providers: {
            "lan-ollama": {
              baseUrl: "http://192.168.1.100:11434",
              models: [],
            },
            "lan-vllm": {
              baseUrl: "http://10.0.0.50:8000",
              models: [],
            },
          },
        },
      });

      expect(result).toBeNull();
    });
  });
});
