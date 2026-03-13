import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { audienceFromWsUrl, resolveGcpIdentityToken } from "./gcp-metadata-token.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);

describe("resolveGcpIdentityToken", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = originalEnv;
    }
    vi.restoreAllMocks();
  });

  describe("ADC path", () => {
    test("resolves identity token from service account key file", async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/gcp/adc.json";
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          type: "service_account",
          client_email: "test@project.iam.gserviceaccount.com",
          private_key: (await import("node:crypto")).generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          }).privateKey,
        }),
      );

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: "adc-identity-token-123" }),
      }) as typeof fetch;

      const result = await resolveGcpIdentityToken("https://mux.example.com");
      expect(result).toEqual({ token: "adc-identity-token-123", source: "adc" });

      // Verify it hit the OAuth2 endpoint, not metadata
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://oauth2.googleapis.com/token");
    });

    test("skips ADC when GOOGLE_APPLICATION_CREDENTIALS not set", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as typeof fetch;

      const token = await resolveGcpIdentityToken("https://mux.example.com");
      expect(token).toBeNull();

      // Should have tried metadata, not OAuth2
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("metadata.google.internal");
    });

    test("skips ADC for non-service_account type and falls to metadata", async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/gcp/adc.json";
      mockReadFile.mockResolvedValue(JSON.stringify({ type: "authorized_user", client_id: "xxx" }));

      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as typeof fetch;

      const token = await resolveGcpIdentityToken("https://mux.example.com");
      expect(token).toBeNull();
    });

    test("falls through to metadata when ADC file is unreadable", async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/adc.json";
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("metadata-token"),
      }) as typeof fetch;

      const result = await resolveGcpIdentityToken("https://mux.example.com");
      expect(result).toEqual({ token: "metadata-token", source: "metadata" });
    });
  });

  describe("metadata path", () => {
    test("returns token from metadata server", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("gcp-oidc-token-123"),
      }) as typeof fetch;

      const result = await resolveGcpIdentityToken("https://mux.example.com");
      expect(result).toEqual({ token: "gcp-oidc-token-123", source: "metadata" });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("audience=https%3A%2F%2Fmux.example.com");
      expect((opts as RequestInit).headers).toEqual({ "Metadata-Flavor": "Google" });
    });

    test("returns null when metadata server is unavailable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as typeof fetch;

      const token = await resolveGcpIdentityToken("https://mux.example.com");
      expect(token).toBeNull();
    });

    test("returns null on non-200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as typeof fetch;

      const token = await resolveGcpIdentityToken("https://mux.example.com");
      expect(token).toBeNull();
    });

    test("returns null on empty response body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("  "),
      }) as typeof fetch;

      const token = await resolveGcpIdentityToken("https://mux.example.com");
      expect(token).toBeNull();
    });

    test("respects custom timeout", async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, opts: RequestInit) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ) as typeof fetch;

      const result = await resolveGcpIdentityToken("https://mux.example.com", { timeoutMs: 50 });
      expect(result).toBeNull();
    });
  });
});

describe("audienceFromWsUrl", () => {
  test("converts wss to https and strips /ws path", () => {
    expect(audienceFromWsUrl("wss://mux.example.com/ws")).toBe("https://mux.example.com");
  });

  test("converts ws to http and strips /ws path", () => {
    expect(audienceFromWsUrl("ws://localhost:8081/ws")).toBe("http://localhost:8081");
  });

  test("strips trailing slash on /ws/", () => {
    expect(audienceFromWsUrl("wss://mux.example.com/ws/")).toBe("https://mux.example.com");
  });

  test("preserves URL without /ws path", () => {
    expect(audienceFromWsUrl("wss://mux.example.com")).toBe("https://mux.example.com");
  });

  test("preserves non-ws paths", () => {
    expect(audienceFromWsUrl("wss://mux.example.com/connect")).toBe(
      "https://mux.example.com/connect",
    );
  });
});
