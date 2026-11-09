import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderApiKeyHttpRequestConfig } from "./provider-http.js";

const { resolveApiKeyForProvider } = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn<() => Promise<{ apiKey?: string }>>(),
}));

vi.mock("./provider-auth-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-auth-runtime.js")>()),
  resolveApiKeyForProvider,
}));

describe("provider API-key HTTP request policy", () => {
  beforeEach(() => {
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-provider-key" });
  });

  it.each([true, false])("assembles Bearer headers with JSON mode %s", async (jsonContentType) => {
    const policy = await resolveProviderApiKeyHttpRequestConfig({
      req: {},
      provider: "together",
      missingApiKeyMessage: "Together API key missing",
      baseUrl: "https://provider.example.test/custom/",
      defaultBaseUrl: "https://api.together.xyz/v2",
      capability: "video",
      jsonContentType,
      defaultHeaders: { "X-Vendor-Version": "2026-01-01" },
    });

    expect(policy.baseUrl).toBe("https://provider.example.test/custom");
    expect(policy.headers.get("authorization")).toBe("Bearer synthetic-provider-key");
    expect(policy.headers.get("content-type")).toBe(jsonContentType ? "application/json" : null);
    expect(policy.headers.get("x-vendor-version")).toBe("2026-01-01");
  });

  it("preserves explicit request headers and private-network policy", async () => {
    const policy = await resolveProviderApiKeyHttpRequestConfig({
      req: {},
      provider: "deepinfra",
      missingApiKeyMessage: "DeepInfra API key missing",
      defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
      capability: "video",
      request: {
        allowPrivateNetwork: true,
        headers: { Authorization: "Bearer synthetic-override", "X-Relay": "configured" },
      },
    });

    expect(policy.headers.get("authorization")).toBe("Bearer synthetic-override");
    expect(policy.headers.get("x-relay")).toBe("configured");
    expect(policy.allowPrivateNetwork).toBe(true);
  });

  it("retains the provider's missing-key error", async () => {
    resolveApiKeyForProvider.mockResolvedValue({});

    await expect(
      resolveProviderApiKeyHttpRequestConfig({
        req: {},
        provider: "runway",
        missingApiKeyMessage: "Runway API key missing",
        defaultBaseUrl: "https://api.dev.runwayml.com/v1",
      }),
    ).rejects.toThrow("Runway API key missing");
  });
});
