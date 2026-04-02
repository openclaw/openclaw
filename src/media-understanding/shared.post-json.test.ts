import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { postJsonRequest } from "./shared.js";

describe("postJsonRequest", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards pinDns to the guarded fetch options", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });

    await postJsonRequest({
      url: "https://example.test/generate",
      headers: new Headers({ Authorization: "Bearer test" }),
      body: { prompt: "hello" },
      timeoutMs: 30_000,
      fetchFn: fetch,
      pinDns: false,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://example.test/generate",
      fetchImpl: fetch,
      init: {
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({ prompt: "hello" }),
      },
      timeoutMs: 30_000,
      policy: undefined,
      lookupFn: undefined,
      pinDns: false,
      dispatcherPolicy: undefined,
    });
  });
});
