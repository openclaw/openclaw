import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("../infra/net/fetch-guard.js", () => ({
  GUARDED_FETCH_MODE: {
    STRICT: "strict",
    TRUSTED_ENV_PROXY: "trusted_env_proxy",
  },
  fetchWithSsrFGuard: vi.fn(),
}));

describe("withRemoteHttpResponse", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses trusted env proxy mode for operator-configured memory endpoints", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      finalUrl: "https://example.com",
      release,
    });

    const result = await withRemoteHttpResponse({
      url: "https://example.com/v1/embeddings",
      onResponse: async (response) => await response.json(),
    });

    expect(result).toEqual({ ok: true });
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/v1/embeddings",
        auditContext: "memory-remote",
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
