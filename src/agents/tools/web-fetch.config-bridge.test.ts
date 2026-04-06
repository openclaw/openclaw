import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
  readResponseTextMock: vi.fn(async () => ({ text: "ok", truncated: false })),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: mocks.fetchWithWebToolsNetworkGuardMock,
}));

vi.mock("./web-fetch-utils.js", () => ({
  extractBasicHtmlContent: vi.fn(),
  extractReadableContent: vi.fn(),
  htmlToMarkdown: vi.fn(),
  markdownToText: vi.fn((value: string) => value),
  truncateText: vi.fn((value: string) => ({ text: value, truncated: false })),
}));

vi.mock("../../security/external-content.js", () => ({
  wrapExternalContent: (value: string) => value,
  wrapWebContent: (value: string) => value,
}));

vi.mock("../../logger.js", () => ({
  logDebug: vi.fn(),
}));

vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: vi.fn(() => null),
}));

vi.mock("./web-shared.js", () => ({
  CacheEntry: class {},
  DEFAULT_CACHE_TTL_MINUTES: 0,
  DEFAULT_TIMEOUT_SECONDS: 30,
  normalizeCacheKey: (value: string) => value,
  readCache: vi.fn(() => null),
  readResponseText: mocks.readResponseTextMock,
  resolveCacheTtlMs: vi.fn(() => 0),
  resolveTimeoutSeconds: vi.fn((_value: unknown, fallback: number) => fallback),
  writeCache: vi.fn(),
}));

import { createWebFetchTool } from "./web-fetch.js";

describe("web_fetch config bridge", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes assumeProxyEnvironment from tools.web.fetch.ssrfPolicy to guarded fetch", async () => {
    mocks.fetchWithWebToolsNetworkGuardMock.mockResolvedValue({
      response: new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              ssrfPolicy: {
                assumeProxyEnvironment: true,
              },
            },
          },
        },
      },
      sandboxed: false,
    });

    await tool?.execute?.("call", { url: "https://example.com" });

    expect(mocks.fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ assumeProxyEnvironment: true }),
      }),
    );
  });

  it("does not pass assumeProxyEnvironment when config is unset", async () => {
    mocks.fetchWithWebToolsNetworkGuardMock.mockResolvedValue({
      response: new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
            },
          },
        },
      },
      sandboxed: false,
    });

    await tool?.execute?.("call", { url: "https://example.com" });

    const call = mocks.fetchWithWebToolsNetworkGuardMock.mock.calls[0]?.[0];
    expect(call?.policy).toBeUndefined();
  });

  it("passes dangerouslyAllowPrivateNetwork from tools.web.fetch.ssrfPolicy to guarded fetch", async () => {
    mocks.fetchWithWebToolsNetworkGuardMock.mockResolvedValue({
      response: new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              ssrfPolicy: {
                dangerouslyAllowPrivateNetwork: true,
              },
            },
          },
        },
      },
      sandboxed: false,
    });

    await tool?.execute?.("call", { url: "https://example.com" });

    expect(mocks.fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ dangerouslyAllowPrivateNetwork: true }),
      }),
    );
  });
});
