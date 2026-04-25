import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock, shouldUseEnvHttpProxyForUrlMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
}));

vi.mock("../../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../../infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/net/proxy-env.js")>(
    "../../infra/net/proxy-env.js",
  );
  return {
    ...actual,
    shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
  };
});

import { GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import { postJson } from "./post-json.js";
import { withRemoteHttpResponse } from "./remote-http.js";

describe("withRemoteHttpResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://memory.example/v1",
      release: vi.fn(async () => {}),
    });
  });

  it("uses trusted env proxy mode when the target will use EnvHttpProxyAgent", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);

    await withRemoteHttpResponse({
      url: "https://memory.example/v1/embeddings",
      onResponse: async () => undefined,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://memory.example/v1/embeddings",
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps strict guarded fetch mode when proxy env would not proxy the target", async () => {
    await withRemoteHttpResponse({
      url: "https://internal.corp.example/v1/embeddings",
      onResponse: async () => undefined,
    });

    const call = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("mode");
  });

  it("wraps transport failures with sanitized request context", async () => {
    const original = new TypeError("fetch failed");
    original.cause = Object.assign(new Error("socket closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    fetchWithSsrFGuardMock.mockRejectedValue(original);

    let caught: unknown;
    try {
      await withRemoteHttpResponse({
        url: "https://memory.example/v1/embeddings?api_key=secret",
        init: { headers: { Authorization: "Bearer sk-test" } },
        auditContext: "memory-remote",
        onResponse: async () => undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { cause?: unknown };
    expect(err.cause).toBe(original);
    expect(err.message).toContain("memory-remote");
    expect(err.message).toContain("https://memory.example/v1/embeddings");
    expect(err.message).toContain("fetch failed");
    expect(err.message).toContain("SocketError");
    expect(err.message).toContain("UND_ERR_SOCKET");
    expect(err.message).not.toContain("api_key");
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("Authorization");
    expect(err.message).not.toContain("sk-test");
  });

  it("preserves existing HTTP status error formatting", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("rate limited", { status: 429 }),
      finalUrl: "https://memory.example/v1/embeddings",
      release: vi.fn(async () => {}),
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/embeddings",
        headers: {},
        body: {},
        errorPrefix: "openai embeddings failed",
        parse: () => ({}),
      }),
    ).rejects.toThrow("openai embeddings failed: 429 rate limited");
  });
});
