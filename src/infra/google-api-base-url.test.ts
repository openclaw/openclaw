// Tests Google API base URL normalization for provider requests.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleVertexBaseUrl,
  normalizeGoogleApiBaseUrl,
  usesGoogleVertexTransportRoute,
} from "./google-api-base-url.js";

describe("normalizeGoogleApiBaseUrl", () => {
  it("defaults to the Gemini v1beta API root", () => {
    expect(normalizeGoogleApiBaseUrl()).toBe(DEFAULT_GOOGLE_API_BASE_URL);
  });

  it.each([
    ["https://generativelanguage.googleapis.com/", DEFAULT_GOOGLE_API_BASE_URL],
    ["https://generativelanguage.googleapis.com/v1beta", DEFAULT_GOOGLE_API_BASE_URL],
    [
      "https://generativelanguage.googleapis.com/v1",
      "https://generativelanguage.googleapis.com/v1",
    ],
    ["https://proxy.example.com/google/v1beta/", "https://proxy.example.com/google/v1beta"],
    ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeGoogleApiBaseUrl(value)).toBe(expected);
  });
});

describe("usesGoogleVertexTransportRoute", () => {
  it("classifies Vertex base URLs and transport routes", () => {
    const h = (s: string) => `https://${s}.googleapis.com/v1`;
    const ai = `${h("generativelanguage")}beta`;
    const reg = h("us-central1-aiplatform");
    const eu = h("aiplatform.eu.rep");
    const g = "google-generative-ai";
    const v = "google-vertex";
    const ok = [h("aiplatform"), `${reg}beta1`, eu, h("aiplatform.us.rep")];
    const no = [ai, h("notaiplatform"), undefined];
    expect(ok.every(isGoogleVertexBaseUrl)).toBe(true);
    expect(no.some(isGoogleVertexBaseUrl)).toBe(false);
    const rt = (api: string, provider: string, baseUrl?: string) =>
      usesGoogleVertexTransportRoute({ api, provider, baseUrl });
    const yes = [rt(v, v), rt(v, "google"), rt(g, v), rt(g, "google", reg), rt(g, "google", eu)];
    const nope = [
      rt(g, "google", ai),
      rt("openai-completions", v, `${reg}beta1/endpoints/openapi`),
    ];
    expect(yes.every(Boolean)).toBe(true);
    expect(nope.some(Boolean)).toBe(false);
  });
});
