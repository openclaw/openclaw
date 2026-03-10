import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  }),
}));

describe("withRemoteHttpResponse", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted env proxy guarded fetch mode by default", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      finalUrl: "https://example.com",
      release,
    });

    const parsed = await withRemoteHttpResponse({
      url: "https://example.com/embeddings",
      init: { method: "POST", body: JSON.stringify({ input: "hello" }) },
      ssrfPolicy: { allowedHostnames: ["example.com"] },
      onResponse: async (response) => await response.json(),
    });

    expect(parsed).toEqual({ ok: true });
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/embeddings",
        policy: { allowedHostnames: ["example.com"] },
        auditContext: "memory-remote",
        mode: "trusted_env_proxy",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still releases dispatcher when response handling throws", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://example.com",
      release,
    });

    await expect(
      withRemoteHttpResponse({
        url: "https://example.com/embeddings",
        auditContext: "memory-embed",
        onResponse: async () => {
          throw new Error("parse failed");
        },
      }),
    ).rejects.toThrow("parse failed");

    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "memory-embed",
        mode: "trusted_env_proxy",
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
