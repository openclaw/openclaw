import { describe, expect, it } from "vitest";
import { resolveProviderHttpRequestConfig } from "./shared.js";

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://api.openai.com/v1",
      headers: {
        authorization: "Bearer override",
        "User-Agent": "custom-agent/1.0",
        originator: "spoofed",
      },
      defaultHeaders: {
        authorization: "Bearer default-token",
        "X-Default": "1",
      },
      provider: "openai",
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(true);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toMatch(/^openclaw\//);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBeTruthy();
  });

  it("uses the fallback base URL without enabling private-network access", () => {
    const resolved = resolveProviderHttpRequestConfig({
      defaultBaseUrl: "https://api.deepgram.com/v1/",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.deepgram.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      api: "google-generative-ai",
      capability: "image",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});
