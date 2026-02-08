import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../../infra/net/ssrf.js";
import { mistralProvider } from "./index.js";

const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;
let resolvePinnedHostnameWithPolicySpy: ReturnType<typeof vi.spyOn> = null;

const resolveRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

describe("mistralProvider", () => {
  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    resolvePinnedHostnameSpy = vi
      .spyOn(ssrf, "resolvePinnedHostname")
      .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
    resolvePinnedHostnameWithPolicySpy = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementation((hostname, params) =>
        resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
      );
  });

  afterEach(() => {
    lookupMock.mockReset();
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameWithPolicySpy?.mockRestore();
    resolvePinnedHostnameSpy = null;
    resolvePinnedHostnameWithPolicySpy = null;
  });

  it("has correct id and capabilities", () => {
    expect(mistralProvider.id).toBe("mistral");
    expect(mistralProvider.capabilities).toEqual(["audio"]);
    expect(mistralProvider.transcribeAudio).toBeDefined();
  });

  it("uses Mistral base URL by default", async () => {
    let seenUrl: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      return new Response(JSON.stringify({ text: "bonjour" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await mistralProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-mistral-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(seenUrl).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(result.text).toBe("bonjour");
  });

  it("allows overriding baseUrl", async () => {
    let seenUrl: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await mistralProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      baseUrl: "https://custom.mistral.example/v1",
      fetchFn,
    });

    expect(seenUrl).toBe("https://custom.mistral.example/v1/audio/transcriptions");
  });
});
