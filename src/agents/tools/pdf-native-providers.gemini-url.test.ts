import { describe, it, expect, vi } from "vitest";
import { geminiAnalyzePdf } from "./pdf-native-providers.js";

// Intercept fetch to capture the URL without making real requests
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input) => {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

function lastCalledUrl(): string {
  const call = fetchSpy.mock.lastCall;
  if (!call) {
    throw new Error("fetch not called");
  }
  const input = call[0];
  return typeof input === "string" ? input : (input as Request).url;
}

const base = {
  apiKey: "test-key",
  modelId: "gemini-3.1-pro-preview",
  prompt: "summarize",
  pdfs: [{ base64: "dGVzdA==", name: "test.pdf" }],
};

describe("geminiAnalyzePdf URL construction", () => {
  it("appends /v1beta when baseUrl has no version segment", async () => {
    await geminiAnalyzePdf({ ...base, baseUrl: "https://generativelanguage.googleapis.com" });
    expect(lastCalledUrl()).toContain("/v1beta/models/");
    expect(lastCalledUrl()).not.toContain("/v1beta/v1beta");
  });

  it("does NOT duplicate /v1beta when baseUrl already includes it", async () => {
    await geminiAnalyzePdf({
      ...base,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    const url = lastCalledUrl();
    expect(url).toContain("/v1beta/models/");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("handles trailing slash on baseUrl", async () => {
    await geminiAnalyzePdf({
      ...base,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    });
    const url = lastCalledUrl();
    expect(url).not.toContain("/v1beta/v1beta");
    expect(url).toContain("/v1beta/models/");
  });
});
