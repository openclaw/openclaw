import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
const resolveFetchMock = vi.fn();

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: (...args: unknown[]) => resolveFetchMock(...args),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureUuid: () => "test-id",
}));

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

import { signalRpcRequest } from "./client.js";

type ErrorWithCause = Error & { cause?: unknown };

describe("signalRpcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFetchMock.mockReturnValue(vi.fn());
  });

  it("returns parsed RPC result", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ jsonrpc: "2.0", result: { version: "0.13.22" }, id: "test-id" }),
        {
          status: 200,
        },
      ),
    );

    const result = await signalRpcRequest<{ version: string }>("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
    });

    expect(result).toEqual({ version: "0.13.22" });
  });

  it("throws a wrapped error when RPC response JSON is malformed", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response("not-json", { status: 502 }));

    const err = (await signalRpcRequest("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
    }).catch((error: unknown) => error)) as ErrorWithCause;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Signal RPC returned malformed JSON (status 502)");
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });
});
