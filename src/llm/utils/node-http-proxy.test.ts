import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHttpProxyUrlForTarget } from "./node-http-proxy.js";

function clearProxyEnv(): void {
  for (const key of [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    vi.stubEnv(key, "");
  }
}

describe("node HTTP proxy resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors unbracketed IPv6 literals in NO_PROXY", () => {
    clearProxyEnv();
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "::1");

    expect(resolveHttpProxyUrlForTarget("http://[::1]:11434/v1")).toBeUndefined();
  });

  it("honors bracketed IPv6 literals with matching NO_PROXY ports", () => {
    clearProxyEnv();
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("NO_PROXY", "[::1]:11434");

    expect(resolveHttpProxyUrlForTarget("http://[::1]:11434/v1")).toBeUndefined();
    expect(resolveHttpProxyUrlForTarget("http://[::1]:11435/v1")?.href).toBe(
      "http://proxy.example:8080/",
    );
  });
});
