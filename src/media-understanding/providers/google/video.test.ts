import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../../infra/net/ssrf.js";
import { withFetchPreconnect } from "../../../test-utils/fetch-mock.js";
import { createRequestCaptureJsonFetch } from "../audio.test-helpers.js";
import { describeGeminiVideo } from "./video.js";

const TEST_NET_IP = "203.0.113.10";

function stubPinnedHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  const addresses = [TEST_NET_IP];
  return {
    hostname: normalized,
    addresses,
    lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
  };
}

describe("describeGeminiVideo", () => {
  let resolvePinnedHostnameWithPolicySpy: ReturnType<typeof vi.spyOn>;
  let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Stub both entry points so fetch-guard never does live DNS (CI can use either path).
    resolvePinnedHostnameWithPolicySpy = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementation(async (hostname) => stubPinnedHostname(hostname));
    resolvePinnedHostnameSpy = vi
      .spyOn(ssrf, "resolvePinnedHostname")
      .mockImplementation(async (hostname) => stubPinnedHostname(hostname));
  });

  afterEach(() => {
    resolvePinnedHostnameWithPolicySpy?.mockRestore();
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameWithPolicySpy = undefined;
    resolvePinnedHostnameSpy = undefined;
  });

  it("respects case-insensitive x-goog-api-key overrides", async () => {
    let seenKey: string | null = null;
    const fetchFn = withFetchPreconnect(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenKey = headers.get("x-goog-api-key");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "video ok" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await describeGeminiVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { "X-Goog-Api-Key": "override" },
      fetchFn,
    });

    expect(seenKey).toBe("override");
    expect(result.text).toBe("video ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      candidates: [
        {
          content: {
            parts: [{ text: "first" }, { text: " second " }, { text: "" }],
          },
        },
      ],
    });

    const result = await describeGeminiVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://example.com/v1beta/",
      model: "gemini-3-pro",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.text).toBe("first\nsecond");
    expect(seenUrl).toBe("https://example.com/v1beta/models/gemini-3-pro-preview:generateContent");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof seenInit?.body === "string"
        ? seenInit.body
        : Buffer.isBuffer(seenInit?.body)
          ? seenInit.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe("Describe the video.");
    expect(body.contents?.[0]?.parts?.[1]?.inline_data?.mime_type).toBe("video/mp4");
    expect(body.contents?.[0]?.parts?.[1]?.inline_data?.data).toBe(
      Buffer.from("video-bytes").toString("base64"),
    );
  });
});
