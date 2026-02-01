import { describe, expect, it } from "vitest";

describe("WhatsApp proxy support", () => {
  it("reads HTTPS_PROXY environment variable", () => {
    const saved = saveProxyEnv();
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBe("http://127.0.0.1:8080");
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it("reads https_proxy (lowercase) when HTTPS_PROXY is not set", () => {
    const saved = saveProxyEnv();
    try {
      process.env.https_proxy = "http://127.0.0.1:8080";
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBe("http://127.0.0.1:8080");
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it("reads HTTP_PROXY when HTTPS_PROXY variants are not set", () => {
    const saved = saveProxyEnv();
    try {
      process.env.HTTP_PROXY = "http://127.0.0.1:1080";
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBe("http://127.0.0.1:1080");
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it("reads http_proxy (lowercase) as last fallback", () => {
    const saved = saveProxyEnv();
    try {
      process.env.http_proxy = "http://127.0.0.1:1080";
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBe("http://127.0.0.1:1080");
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it("prefers HTTPS_PROXY over lowercase variants", () => {
    const saved = saveProxyEnv();
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
      process.env.https_proxy = "http://127.0.0.1:9090";
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBe("http://127.0.0.1:8080");
    } finally {
      restoreProxyEnv(saved);
    }
  });

  it("returns undefined when no proxy environment variables are set", () => {
    const saved = saveProxyEnv();
    try {
      const proxyUrl = resolveProxyUrl();
      expect(proxyUrl).toBeUndefined();
    } finally {
      restoreProxyEnv(saved);
    }
  });
});

function resolveProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

function saveProxyEnv() {
  return {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
  };
}

function restoreProxyEnv(saved: ReturnType<typeof saveProxyEnv>) {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  if (saved.HTTPS_PROXY) process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
  if (saved.https_proxy) process.env.https_proxy = saved.https_proxy;
  if (saved.HTTP_PROXY) process.env.HTTP_PROXY = saved.HTTP_PROXY;
  if (saved.http_proxy) process.env.http_proxy = saved.http_proxy;
}
