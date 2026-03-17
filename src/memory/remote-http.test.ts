import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";

const fetchWithSsrFGuardMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

let withRemoteHttpResponse: typeof import("./remote-http.js").withRemoteHttpResponse;

describe("withRemoteHttpResponse", () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchWithSsrFGuardMock.mockReset();
    ({ withRemoteHttpResponse } = await import("./remote-http.js"));
  });

  it("uses trusted env proxy mode for public remote hosts", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/embeddings",
      release: vi.fn(async () => {}),
    });

    await withRemoteHttpResponse({
      url: "https://api.openai.com/v1/embeddings",
      onResponse: async () => "ok",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/embeddings",
        mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      }),
    );
  });

  it("keeps localhost targets on direct guarded fetches", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 }),
      finalUrl: "http://127.0.0.1:11434/api/embeddings",
      release: vi.fn(async () => {}),
    });

    await withRemoteHttpResponse({
      url: "http://127.0.0.1:11434/api/embeddings",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      onResponse: async () => "ok",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:11434/api/embeddings",
        policy: { allowedHostnames: ["127.0.0.1"] },
      }),
    );
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).not.toHaveProperty("mode");
  });
});
