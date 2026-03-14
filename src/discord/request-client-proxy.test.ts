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

  it("does not mutate multipart attachment metadata across repeated executions of the same request", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const rest = new RequestClient("token-123", { queueRequests: false });
    applyDiscordProxyToRequestClient(rest, "http://proxy.test:8080");

    type MultipartRequest = {
      method: "POST";
      path: string;
      data: {
        body: {
          files: Array<{ data: Blob; name: string }>;
          attachments?: unknown[];
        };
      };
      routeKey: string;
    };

    const request: MultipartRequest = {
      method: "POST",
      path: "/channels/123/messages",
      data: {
        body: {
          files: [{ data: new Blob(["hello"]), name: "hello.txt" }],
        },
      },
      routeKey: "POST:/channels/123/messages",
    };

    const executeRequest = (
      rest as unknown as { executeRequest: (request: MultipartRequest) => Promise<unknown> }
    ).executeRequest;

    await executeRequest(request);
    await executeRequest(request);

    const firstCall = fetchMock.mock.calls[0]?.[1] as { body?: FormData } | undefined;
    const secondCall = fetchMock.mock.calls[1]?.[1] as { body?: FormData } | undefined;
    const firstPayload = JSON.parse(
      (Array.from((firstCall?.body ?? new FormData()).entries()).find(
        ([key]) => key === "payload_json",
      )?.[1] as string) ?? "{}",
    ) as { attachments?: unknown[] };
    const secondPayload = JSON.parse(
      (Array.from((secondCall?.body ?? new FormData()).entries()).find(
        ([key]) => key === "payload_json",
      )?.[1] as string) ?? "{}",
    ) as { attachments?: unknown[] };

    expect(firstPayload.attachments).toHaveLength(1);
    expect(secondPayload.attachments).toHaveLength(1);
    expect((request.data.body as { attachments?: unknown[] }).attachments).toBeUndefined();
  });

  it("reads the current token for each proxied request", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const rest = new RequestClient("token-123", { queueRequests: false });
    applyDiscordProxyToRequestClient(rest, "http://proxy.test:8080");
    (rest as unknown as { token: string }).token = "rotated-token";

    await rest.get("/users/@me");

    const headers = (fetchMock.mock.calls[0]?.[1] as { headers?: Headers } | undefined)?.headers;
    expect(headers?.get("Authorization")).toBe("Bot rotated-token");
  });

  it("does not append a trailing question mark for empty query objects", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const rest = new RequestClient("token-123", { queueRequests: false });
    applyDiscordProxyToRequestClient(rest, "http://proxy.test:8080");

    await rest.get("/users/@me", {});

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://discord.com/api/users/@me");
  });
});
