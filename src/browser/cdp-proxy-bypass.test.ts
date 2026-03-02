import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDirectAgentForCdp, hasProxyEnv, withNoProxyForLocalhost } from "./cdp-proxy-bypass.js";

describe("cdp-proxy-bypass", () => {
  describe("getDirectAgentForCdp", () => {
    it("returns http.Agent for http://localhost URLs", () => {
      const agent = getDirectAgentForCdp("http://localhost:9222");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns http.Agent for http://127.0.0.1 URLs", () => {
      const agent = getDirectAgentForCdp("http://127.0.0.1:9222/json/version");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns https.Agent for wss://localhost URLs", () => {
      const agent = getDirectAgentForCdp("wss://localhost:9222");
      expect(agent).toBeInstanceOf(https.Agent);
    });

    it("returns http.Agent for ws://[::1] URLs", () => {
      const agent = getDirectAgentForCdp("ws://[::1]:9222");
      expect(agent).toBeInstanceOf(http.Agent);
    });

    it("returns undefined for non-loopback URLs", () => {
      expect(getDirectAgentForCdp("http://remote-host:9222")).toBeUndefined();
      expect(getDirectAgentForCdp("https://example.com:9222")).toBeUndefined();
    });

    it("returns undefined for invalid URLs", () => {
      expect(getDirectAgentForCdp("not-a-url")).toBeUndefined();
    });
  });

  describe("hasProxyEnv", () => {
    const proxyVars = [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const v of proxyVars) {
        saved[v] = process.env[v];
      }
      for (const v of proxyVars) {
        delete process.env[v];
      }
    });

    afterEach(() => {
      for (const v of proxyVars) {
        if (saved[v] !== undefined) {
          process.env[v] = saved[v];
        } else {
          delete process.env[v];
        }
      }
    });

    it("returns false when no proxy vars set", () => {
      expect(hasProxyEnv()).toBe(false);
    });

    it("returns true when HTTP_PROXY is set", () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      expect(hasProxyEnv()).toBe(true);
    });

    it("returns true when ALL_PROXY is set", () => {
      process.env.ALL_PROXY = "socks5://proxy:1080";
      expect(hasProxyEnv()).toBe(true);
    });
  });

  describe("withNoProxyForLocalhost", () => {
    const saved: Record<string, string | undefined> = {};
    const vars = ["HTTP_PROXY", "NO_PROXY", "no_proxy"];

    beforeEach(() => {
      for (const v of vars) {
        saved[v] = process.env[v];
      }
    });

    afterEach(() => {
      for (const v of vars) {
        if (saved[v] !== undefined) {
          process.env[v] = saved[v];
        } else {
          delete process.env[v];
        }
      }
    });

    it("sets NO_PROXY when proxy is configured", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      let capturedNoProxy: string | undefined;
      await withNoProxyForLocalhost(async () => {
        capturedNoProxy = process.env.NO_PROXY;
      });

      expect(capturedNoProxy).toContain("localhost");
      expect(capturedNoProxy).toContain("127.0.0.1");
      expect(capturedNoProxy).toContain("[::1]");
      // Restored after
      expect(process.env.NO_PROXY).toBeUndefined();
    });

    it("extends existing NO_PROXY", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      process.env.NO_PROXY = "internal.corp";

      let capturedNoProxy: string | undefined;
      await withNoProxyForLocalhost(async () => {
        capturedNoProxy = process.env.NO_PROXY;
      });

      expect(capturedNoProxy).toContain("internal.corp");
      expect(capturedNoProxy).toContain("localhost");
      // Restored
      expect(process.env.NO_PROXY).toBe("internal.corp");
    });

    it("skips when no proxy env is set", async () => {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.NO_PROXY;

      await withNoProxyForLocalhost(async () => {
        expect(process.env.NO_PROXY).toBeUndefined();
      });
    });

    it("restores env even on error", async () => {
      process.env.HTTP_PROXY = "http://proxy:8080";
      delete process.env.NO_PROXY;

      await expect(
        withNoProxyForLocalhost(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(process.env.NO_PROXY).toBeUndefined();
    });
  });
});
