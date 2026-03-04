import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiAnalyzePdf } from "./pdf-native-providers.js";

describe("geminiAnalyzePdf URL normalization", () => {
  const basePdfParams = {
    apiKey: "test-key",
    modelId: "gemini-2.0-flash",
    prompt: "Summarize this PDF",
    pdfs: [{ base64: "AAAA" }],
  };

  function captureFetchUrl(): string[] {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as Request).url);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200 },
      );
    });
    return urls;
  }

  afterEach(() => vi.restoreAllMocks());

  it("constructs correct URL when baseUrl has no /v1beta suffix", async () => {
    const urls = captureFetchUrl();
    await geminiAnalyzePdf({
      ...basePdfParams,
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(urls[0]).toContain("/v1beta/models/");
    expect(urls[0]).not.toContain("/v1beta/v1beta/");
  });

  it("prevents /v1beta duplication when baseUrl already ends with /v1beta", async () => {
    const urls = captureFetchUrl();
    await geminiAnalyzePdf({
      ...basePdfParams,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(urls[0]).toContain("/v1beta/models/");
    expect(urls[0]).not.toContain("/v1beta/v1beta/");
  });

  it("handles baseUrl with trailing slash and /v1beta/", async () => {
    const urls = captureFetchUrl();
    await geminiAnalyzePdf({
      ...basePdfParams,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    });
    expect(urls[0]).toContain("/v1beta/models/");
    expect(urls[0]).not.toContain("/v1beta/v1beta/");
  });

  it("uses default baseUrl when none provided", async () => {
    const urls = captureFetchUrl();
    await geminiAnalyzePdf(basePdfParams);
    expect(urls[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//);
  });
});
