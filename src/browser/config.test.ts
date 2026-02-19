import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile, shouldStartLocalBrowserServer } from "./config.js";

describe("browser config", () => {
  it("defaults to enabled with loopback defaults and lobster-orange color", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.enabled).toBe(true);
    expect(resolved.controlPort).toBe(18791);
    expect(resolved.color).toBe("#FF4500");
    expect(shouldStartLocalBrowserServer(resolved)).toBe(true);
    expect(resolved.cdpHost).toBe("127.0.0.1");
    expect(resolved.cdpProtocol).toBe("http");
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    expect(profile?.name).toBe("chrome");
    expect(profile?.driver).toBe("extension");
    expect(profile?.cdpPort).toBe(18792);
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:18792");

    const openclaw = resolveProfile(resolved, "openclaw");
    expect(openclaw?.driver).toBe("openclaw");
    expect(openclaw?.cdpPort).toBe(18800);
    expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:18800");
    expect(resolved.remoteCdpTimeoutMs).toBe(1500);
    expect(resolved.remoteCdpHandshakeTimeoutMs).toBe(3000);
  });

  it("derives default ports from OPENCLAW_GATEWAY_PORT when unset", () => {
    const prev = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = "19001";
    try {
      const resolved = resolveBrowserConfig(undefined);
      expect(resolved.controlPort).toBe(19003);
      const chrome = resolveProfile(resolved, "chrome");
      expect(chrome?.driver).toBe("extension");
      expect(chrome?.cdpPort).toBe(19004);
      expect(chrome?.cdpUrl).toBe("http://127.0.0.1:19004");

      const openclaw = resolveProfile(resolved, "openclaw");
      expect(openclaw?.cdpPort).toBe(19012);
      expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:19012");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = prev;
      }
    }
  });

  it("derives default ports from gateway.port when env is unset", () => {
    const prev = process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    try {
      const resolved = resolveBrowserConfig(undefined, { gateway: { port: 19011 } });
      expect(resolved.controlPort).toBe(19013);
      const chrome = resolveProfile(resolved, "chrome");
      expect(chrome?.driver).toBe("extension");
      expect(chrome?.cdpPort).toBe(19014);
      expect(chrome?.cdpUrl).toBe("http://127.0.0.1:19014");

      const openclaw = resolveProfile(resolved, "openclaw");
      expect(openclaw?.cdpPort).toBe(19022);
      expect(openclaw?.cdpUrl).toBe("http://127.0.0.1:19022");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = prev;
      }
    }
  });

  it("normalizes hex colors", () => {
    const resolved = resolveBrowserConfig({
      color: "ff4500",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("supports custom remote CDP timeouts", () => {
    const resolved = resolveBrowserConfig({
      remoteCdpTimeoutMs: 2200,
      remoteCdpHandshakeTimeoutMs: 5000,
    });
    expect(resolved.remoteCdpTimeoutMs).toBe(2200);
    expect(resolved.remoteCdpHandshakeTimeoutMs).toBe(5000);
  });

  it("falls back to default color for invalid hex", () => {
    const resolved = resolveBrowserConfig({
      color: "#GGGGGG",
    });
    expect(resolved.color).toBe("#FF4500");
  });

  it("treats non-loopback cdpUrl as remote", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("supports explicit CDP URLs for the default profile", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "http://example.com:9222",
    });
    const profile = resolveProfile(resolved, "openclaw");
    expect(profile?.cdpPort).toBe(9222);
    expect(profile?.cdpUrl).toBe("http://example.com:9222");
    expect(profile?.cdpIsLoopback).toBe(false);
  });

  it("uses profile cdpUrl when provided", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        remote: { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" },
      },
    });

    const remote = resolveProfile(resolved, "remote");
    expect(remote?.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(remote?.cdpHost).toBe("10.0.0.42");
    expect(remote?.cdpIsLoopback).toBe(false);
  });

  it("uses base protocol for profiles with only cdpPort", () => {
    const resolved = resolveBrowserConfig({
      cdpUrl: "https://example.com:9443",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });

    const work = resolveProfile(resolved, "work");
    expect(work?.cdpUrl).toBe("https://example.com:18801");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveBrowserConfig({ cdpUrl: "ws://127.0.0.1:18791" })).toThrow(/must be http/i);
  });

  it("does not add the built-in chrome extension profile if the derived relay port is already used", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        openclaw: { cdpPort: 18792, color: "#FF4500" },
      },
    });
    expect(resolveProfile(resolved, "chrome")).toBe(null);
    expect(resolved.defaultProfile).toBe("openclaw");
  });

  it("defaults extraArgs to empty array when not provided", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.extraArgs).toEqual([]);
  });

  it("passes through valid extraArgs strings", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--no-sandbox", "--disable-gpu"],
    });
    expect(resolved.extraArgs).toEqual(["--no-sandbox", "--disable-gpu"]);
  });

  it("filters out empty strings and whitespace-only entries from extraArgs", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--flag", "", "  ", "--other"],
    });
    expect(resolved.extraArgs).toEqual(["--flag", "--other"]);
  });

  it("filters out non-string entries from extraArgs", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: ["--flag", 42, null, undefined, true, "--other"] as unknown as string[],
    });
    expect(resolved.extraArgs).toEqual(["--flag", "--other"]);
  });

  it("defaults extraArgs to empty array when set to non-array", () => {
    const resolved = resolveBrowserConfig({
      extraArgs: "not-an-array" as unknown as string[],
    });
    expect(resolved.extraArgs).toEqual([]);
  });

  // Proxy tests
  it("defaults proxy to undefined when not provided", () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.proxy).toBeUndefined();
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("resolves a valid http proxy URL", () => {
    const resolved = resolveBrowserConfig({ proxy: "http://127.0.0.1:7890" });
    expect(resolved.proxy).toBe("http://127.0.0.1:7890");
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("resolves a valid https proxy URL", () => {
    const resolved = resolveBrowserConfig({ proxy: "https://proxy.example.com:8443" });
    expect(resolved.proxy).toBe("https://proxy.example.com:8443");
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("resolves a valid socks5 proxy URL", () => {
    const resolved = resolveBrowserConfig({ proxy: "socks5://proxy.example.com:1080" });
    expect(resolved.proxy).toBe("socks5://proxy.example.com:1080");
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("trims whitespace from proxy URL", () => {
    const resolved = resolveBrowserConfig({ proxy: "  http://127.0.0.1:7890  " });
    expect(resolved.proxy).toBe("http://127.0.0.1:7890");
  });

  it("treats empty proxy string as unset", () => {
    const resolved = resolveBrowserConfig({ proxy: "" });
    expect(resolved.proxy).toBeUndefined();
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("treats whitespace-only proxy string as unset", () => {
    const resolved = resolveBrowserConfig({ proxy: "   " });
    expect(resolved.proxy).toBeUndefined();
    expect(resolved.proxyCredentials).toBeUndefined();
  });

  it("rejects proxy URL with unsupported scheme", () => {
    expect(() => resolveBrowserConfig({ proxy: "ftp://proxy.example.com:21" })).toThrow(
      /must start with http/i,
    );
  });

  it("rejects proxy URL with invalid format", () => {
    expect(() => resolveBrowserConfig({ proxy: "not-a-url" })).toThrow();
  });

  it("rejects proxy URL with path, query, or hash", () => {
    expect(() => resolveBrowserConfig({ proxy: "http://proxy.example.com:8080/path" })).toThrow(
      /must not include path, query, or hash/i,
    );
    expect(() =>
      resolveBrowserConfig({ proxy: "http://proxy.example.com:8080?token=abc" }),
    ).toThrow(/must not include path, query, or hash/i);
    expect(() => resolveBrowserConfig({ proxy: "http://proxy.example.com:8080#frag" })).toThrow(
      /must not include path, query, or hash/i,
    );
  });

  it("extracts credentials from proxy URL and strips them from server", () => {
    const resolved = resolveBrowserConfig({ proxy: "http://user:p%40ss@proxy.example.com:8080" });
    expect(resolved.proxy).toBe("http://proxy.example.com:8080");
    expect(resolved.proxyCredentials).toEqual({ username: "user", password: "p@ss" });
  });

  it("extracts credentials from socks5 proxy URL", () => {
    const resolved = resolveBrowserConfig({ proxy: "socks5://myuser:mypass@proxy:1080" });
    expect(resolved.proxy).toBe("socks5://proxy:1080");
    expect(resolved.proxyCredentials).toEqual({ username: "myuser", password: "mypass" });
  });

  it("supports unicode credentials in proxy URL", () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://%E2%9C%93:%F0%9F%94%91@proxy.example.com:8080",
    });
    expect(resolved.proxy).toBe("http://proxy.example.com:8080");
    expect(resolved.proxyCredentials).toEqual({ username: "✓", password: "🔑" });
  });

  it("rejects malformed percent-encoding in proxy credentials", () => {
    expect(() =>
      resolveBrowserConfig({ proxy: "http://user:%ZZ@proxy.example.com:8080" }),
    ).toThrow();
  });

  it("profile proxy overrides global proxy", () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://global:8080",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC", proxy: "socks5://work:1080" },
      },
    });
    const work = resolveProfile(resolved, "work");
    expect(work?.proxy).toBe("socks5://work:1080");

    const openclaw = resolveProfile(resolved, "openclaw");
    expect(openclaw?.proxy).toBe("http://global:8080");
  });

  it("profile inherits global proxy when not set", () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://global:8080",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });
    const work = resolveProfile(resolved, "work");
    expect(work?.proxy).toBe("http://global:8080");
  });

  it("profile inherits global proxy credentials when not set", () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://user:pass@global:8080",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC" },
      },
    });
    const work = resolveProfile(resolved, "work");
    expect(work?.proxy).toBe("http://global:8080");
    expect(work?.proxyCredentials).toEqual({ username: "user", password: "pass" });
  });

  it("profile proxy credentials override global credentials", () => {
    const resolved = resolveBrowserConfig({
      proxy: "http://globaluser:globalpass@global:8080",
      profiles: {
        work: { cdpPort: 18801, color: "#0066CC", proxy: "http://workuser:workpass@work:9090" },
      },
    });
    const work = resolveProfile(resolved, "work");
    expect(work?.proxy).toBe("http://work:9090");
    expect(work?.proxyCredentials).toEqual({ username: "workuser", password: "workpass" });

    const openclaw = resolveProfile(resolved, "openclaw");
    expect(openclaw?.proxyCredentials).toEqual({ username: "globaluser", password: "globalpass" });
  });
});
