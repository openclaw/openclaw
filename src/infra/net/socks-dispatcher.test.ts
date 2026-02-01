import { afterEach, describe, expect, it } from "vitest";
import { EnvHttpProxyAgent } from "undici";
import {
  installSocksGlobalDispatcher,
  isSocksProxyUrl,
  parseSocksUrl,
} from "./socks-dispatcher.js";

describe("isSocksProxyUrl", () => {
  it("returns true for socks5h URLs", () => {
    expect(isSocksProxyUrl("socks5h://proxy.example.com:1080")).toBe(true);
  });

  it("returns true for socks5 URLs", () => {
    expect(isSocksProxyUrl("socks5://proxy.example.com:1080")).toBe(true);
  });

  it("returns true for socks4 URLs", () => {
    expect(isSocksProxyUrl("socks4://proxy.example.com:1080")).toBe(true);
  });

  it("returns true for socks4a URLs", () => {
    expect(isSocksProxyUrl("socks4a://proxy.example.com:1080")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSocksProxyUrl("SOCKS5H://proxy.example.com:1080")).toBe(true);
    expect(isSocksProxyUrl("Socks5://proxy.example.com:1080")).toBe(true);
  });

  it("returns false for http URLs", () => {
    expect(isSocksProxyUrl("http://proxy.example.com:8080")).toBe(false);
  });

  it("returns false for https URLs", () => {
    expect(isSocksProxyUrl("https://proxy.example.com:8080")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isSocksProxyUrl("")).toBe(false);
  });

  it("handles whitespace-padded URLs", () => {
    expect(isSocksProxyUrl("  socks5h://proxy.example.com:1080  ")).toBe(true);
  });
});

describe("parseSocksUrl", () => {
  it("parses socks5h URL with host and port", () => {
    const config = parseSocksUrl("socks5h://egress.unsandbox.com:1080");
    expect(config).toEqual({
      host: "egress.unsandbox.com",
      port: 1080,
      type: 5,
    });
  });

  it("parses socks5 URL", () => {
    const config = parseSocksUrl("socks5://proxy.local:9050");
    expect(config).toEqual({
      host: "proxy.local",
      port: 9050,
      type: 5,
    });
  });

  it("parses socks4 URL", () => {
    const config = parseSocksUrl("socks4://proxy.local:1080");
    expect(config).toEqual({
      host: "proxy.local",
      port: 1080,
      type: 4,
    });
  });

  it("parses socks4a URL", () => {
    const config = parseSocksUrl("socks4a://proxy.local:1080");
    expect(config).toEqual({
      host: "proxy.local",
      port: 1080,
      type: 4,
    });
  });

  it("defaults port to 1080 when omitted", () => {
    const config = parseSocksUrl("socks5h://proxy.local");
    expect(config.port).toBe(1080);
  });

  it("parses credentials from URL", () => {
    const config = parseSocksUrl("socks5://user:pass@proxy.local:1080");
    expect(config).toEqual({
      host: "proxy.local",
      port: 1080,
      type: 5,
      userId: "user",
      password: "pass",
    });
  });

  it("decodes percent-encoded credentials", () => {
    const config = parseSocksUrl("socks5://us%40er:p%23ss@proxy.local:1080");
    expect(config.userId).toBe("us@er");
    expect(config.password).toBe("p#ss");
  });

  it("parses user-only auth (no password)", () => {
    const config = parseSocksUrl("socks5://user@proxy.local:1080");
    expect(config.userId).toBe("user");
    expect(config.password).toBeUndefined();
  });

  it("throws for unsupported protocols", () => {
    expect(() => parseSocksUrl("http://proxy.local:8080")).toThrow("Unsupported SOCKS URL");
  });

  it("throws for missing host", () => {
    expect(() => parseSocksUrl("socks5h://:1080")).toThrow();
  });

  it("rejects port 0", () => {
    expect(() => parseSocksUrl("socks5h://proxy.local:0")).toThrow("Invalid port");
  });

  it("rejects port above 65535", () => {
    // URL constructor already rejects ports > 65535, so this throws too.
    expect(() => parseSocksUrl("socks5h://proxy.local:70000")).toThrow();
  });

  it("redacts credentials in error messages", () => {
    try {
      parseSocksUrl("badscheme://user:secret@proxy.local:1080");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("secret");
      expect(message).toContain("***@");
      return;
    }
    expect.fail("expected parseSocksUrl to throw");
  });

  it("handles uppercase scheme", () => {
    const config = parseSocksUrl("SOCKS5H://proxy.local:1080");
    expect(config.type).toBe(5);
    expect(config.host).toBe("proxy.local");
  });
});

describe("installSocksGlobalDispatcher", () => {
  const ENV_KEYS = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;

  // Save and restore env vars around each test.
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function saveAndClearEnv(): void {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("sanitizes SOCKS URLs from env so EnvHttpProxyAgent does not throw", () => {
    saveAndClearEnv();
    process.env.HTTP_PROXY = "socks5h://proxy.test:1080";
    process.env.HTTPS_PROXY = "socks5h://proxy.test:1080";

    // Before sanitization, EnvHttpProxyAgent would crash on the SOCKS URL.
    expect(() => new EnvHttpProxyAgent()).toThrow();

    installSocksGlobalDispatcher();

    // After installSocksGlobalDispatcher, SOCKS env vars are removed and
    // EnvHttpProxyAgent can construct without error.
    expect(() => new EnvHttpProxyAgent()).not.toThrow();
  });

  it("removes all SOCKS proxy env vars", () => {
    saveAndClearEnv();
    process.env.HTTP_PROXY = "socks5h://proxy.test:1080";
    process.env.HTTPS_PROXY = "socks5://proxy.test:1080";
    process.env.ALL_PROXY = "socks4://proxy.test:1080";

    installSocksGlobalDispatcher();

    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.ALL_PROXY).toBeUndefined();
  });

  it("leaves non-SOCKS proxy env vars intact", () => {
    saveAndClearEnv();
    process.env.HTTP_PROXY = "http://proxy.test:8080";
    process.env.HTTPS_PROXY = "http://proxy.test:8080";

    installSocksGlobalDispatcher();

    expect(process.env.HTTP_PROXY).toBe("http://proxy.test:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.test:8080");
  });

  it("is a no-op when no SOCKS proxy is configured", () => {
    saveAndClearEnv();

    // Should not throw even with no env vars set.
    expect(() => installSocksGlobalDispatcher()).not.toThrow();
  });
});
