import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("./http-auth-helpers.js", () => {
  return {
    authorizeGatewayBearerRequestOrReply: vi.fn(),
  };
});

vi.mock("./http-common.js", () => {
  return {
    readJsonBodyOrError: vi.fn(),
    sendMethodNotAllowed: vi.fn(),
  };
});

const { authorizeGatewayBearerRequestOrReply } = await import("./http-auth-helpers.js");
const { readJsonBodyOrError, sendMethodNotAllowed } = await import("./http-common.js");

describe("handleGatewayPostJsonEndpoint", () => {
  it("returns false when path does not match", async () => {
    const result = await handleGatewayPostJsonEndpoint(
      {
        url: "/nope",
        method: "POST",
        headers: { host: "localhost" },
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { pathname: "/v1/ok", auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1 },
    );
    expect(result).toBe(false);
  });

  it("returns undefined and replies when method is not POST", async () => {
    const mockedSendMethodNotAllowed = vi.mocked(sendMethodNotAllowed);
    mockedSendMethodNotAllowed.mockClear();
    const result = await handleGatewayPostJsonEndpoint(
      {
        url: "/v1/ok",
        method: "GET",
        headers: { host: "localhost" },
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { pathname: "/v1/ok", auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1 },
    );
    expect(result).toBeUndefined();
    expect(mockedSendMethodNotAllowed).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when auth fails", async () => {
    vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(false);
    const result = await handleGatewayPostJsonEndpoint(
      {
        url: "/v1/ok",
        method: "POST",
        headers: { host: "localhost" },
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { pathname: "/v1/ok", auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 1 },
    );
    expect(result).toBeUndefined();
  });

  it("returns body when auth succeeds and JSON parsing succeeds", async () => {
    vi.mocked(authorizeGatewayBearerRequestOrReply).mockResolvedValue(true);
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ hello: "world" });
    const result = await handleGatewayPostJsonEndpoint(
      {
        url: "/v1/ok",
        method: "POST",
        headers: { host: "localhost" },
      } as unknown as IncomingMessage,
      {} as unknown as ServerResponse,
      { pathname: "/v1/ok", auth: {} as unknown as ResolvedGatewayAuth, maxBodyBytes: 123 },
    );
    expect(result).toEqual({ body: { hello: "world" } });
  });
});
