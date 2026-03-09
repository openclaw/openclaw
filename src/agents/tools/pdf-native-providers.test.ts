import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { geminiAnalyzePdf } from "./pdf-native-providers";

describe("geminiAnalyzePdf", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // We cast to unknown as Response because we only mock what we need
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: "success" }] } }] }),
      text: () => Promise.resolve(""),
      status: 200,
      ok: true,
    } as unknown as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips 'google/' provider prefix from modelId", async () => {
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "google/gemini-2.0-flash",
      prompt: "test",
      pdfs: [],
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/models/gemini-2.0-flash:generateContent");
    expect(url).not.toContain("google/gemini-2.0-flash");
  });

  it("preserves nested paths in modelId without stripping too much", async () => {
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "google/tunedModels/my-model",
      prompt: "test",
      pdfs: [],
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/models/tunedModels%2Fmy-model:generateContent");
  });

  it("leaves modelId unchanged if no 'google/' prefix is present", async () => {
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "gemini-1.5-pro",
      prompt: "test",
      pdfs: [],
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/models/gemini-1.5-pro:generateContent");
  });

  it("normalizes baseUrl by stripping trailing slashes", async () => {
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "gemini-1.5-pro",
      prompt: "test",
      pdfs: [],
      baseUrl: "https://my-proxy.com/",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).to.equal(
      "https://my-proxy.com/v1beta/models/gemini-1.5-pro:generateContent?key=test-key",
    );
  });

  it("normalizes baseUrl by stripping /v1 or /v1beta path segments to prevent double-versioning", async () => {
    // Simulating Cloudflare AI Gateway or Litellm proxy URL
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "gemini-1.5-pro",
      prompt: "test",
      pdfs: [],
      baseUrl: "https://gateway.ai.cloudflare.com/v1/my-acc/my-gate/google-ai-studio/v1beta",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;

    // We expect the trailing /v1beta on the proxy URL to be stripped so that
    // the hardcoded /v1beta/models/... path appended by the function doesn't duplicate it.
    expect(url).to.equal(
      "https://gateway.ai.cloudflare.com/v1/my-acc/my-gate/google-ai-studio/v1beta/models/gemini-1.5-pro:generateContent?key=test-key",
    );
  });

  it("normalizes baseUrl by stripping /v1 path segment", async () => {
    await geminiAnalyzePdf({
      apiKey: "test-key",
      modelId: "gemini-1.5-pro",
      prompt: "test",
      pdfs: [],
      baseUrl: "https://my-proxy.com/v1",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).to.equal(
      "https://my-proxy.com/v1beta/models/gemini-1.5-pro:generateContent?key=test-key",
    );
  });
});
