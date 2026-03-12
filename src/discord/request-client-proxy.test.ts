import { RequestClient } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDiscordProxyToRequestClient } from "./request-client-proxy.js";

const { fetchMock, makeProxyFetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  makeProxyFetchMock: vi.fn(),
}));

vi.mock("../infra/net/proxy-fetch.js", () => ({
  makeProxyFetch: makeProxyFetchMock,
}));

describe("applyDiscordProxyToRequestClient", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    makeProxyFetchMock.mockReset().mockReturnValue(fetchMock);
  });

  it("routes RequestClient REST calls through the configured proxy fetch", async () => {
    const directFetchSpy = vi.spyOn(globalThis, "fetch");
    directFetchSpy.mockRejectedValue(new Error("direct fetch should not be used"));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const rest = new RequestClient("token-123", { queueRequests: false });

      applyDiscordProxyToRequestClient(rest, "http://proxy.test:8080");
      const user = await rest.get("/users/@me");

      expect(user).toEqual({ id: "123" });
      expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/users/@me",
        expect.objectContaining({
          method: "GET",
          signal: expect.any(AbortSignal),
          headers: expect.any(Headers),
        }),
      );
      expect(directFetchSpy).not.toHaveBeenCalled();
    } finally {
      directFetchSpy.mockRestore();
    }
  });
});
