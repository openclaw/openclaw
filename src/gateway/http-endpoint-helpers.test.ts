/**
 * Unit tests for the shared POST JSON endpoint helper used by gateway HTTP surfaces.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("./http-utils.js", () => {
  return {
    authorizeGatewayHttpRequestOrReply: vi.fn(),
    resolveTrustedHttpOperatorScopes: vi.fn(),
  };
});

vi.mock("./http-common.js", () => {
  return {
    readJsonBodyOrError: vi.fn(),
    sendJson: vi.fn(),
    sendMethodNotAllowed: vi.fn(),
    sendMissingScopeForbidden: vi.fn(),
  };
});

vi.mock("./method-scopes.js", () => {
  return {
    authorizeOperatorScopesForMethod: vi.fn(),
  };
});

const { readJsonBodyOrError, sendMethodNotAllowed, sendMissingScopeForbidden } =
  await import("./http-common.js");
const { authorizeGatewayHttpRequestOrReply, resolveTrustedHttpOperatorScopes } =
  await import("./http-utils.js");
const { authorizeOperatorScopesForMethod } = await import("./method-scopes.js");

type EndpointOptions = Parameters<typeof handleGatewayPostJsonEndpoint>[2];
type RequestAuth = NonNullable<Awaited<ReturnType<typeof authorizeGatewayHttpRequestOrReply>>>;
type RequestOptions = {
  url?: string;
  method?: string;
  host?: string;
};

function request(options: RequestOptions = {}): IncomingMessage {
  return {
    url: options.url ?? "/v1/ok",
    method: options.method ?? "POST",
    headers: { host: options.host ?? "localhost" },
  } as unknown as IncomingMessage;
}

function response(): ServerResponse {
  return {} as unknown as ServerResponse;
}

function authorizedRequest(overrides: Partial<RequestAuth> = {}): RequestAuth {
  return {
    trustDeclaredOperatorScopes: true,
    hasCurrentClientAuthority: () => true,
    assertCurrent: () => {},
    revalidate: async () => {},
    ...overrides,
  };
}

function endpointOptions(overrides: Partial<EndpointOptions> = {}): EndpointOptions {
  return {
    pathname: "/v1/ok",
    auth: {} as unknown as ResolvedGatewayAuth,
    maxBodyBytes: 123,
    ...overrides,
  };
}

function handleEndpoint(
  options: {
    request?: RequestOptions;
    response?: ServerResponse;
    endpoint?: Partial<EndpointOptions>;
  } = {},
) {
  return handleGatewayPostJsonEndpoint(
    request(options.request),
    options.response ?? response(),
    endpointOptions(options.endpoint),
  );
}

describe("handleGatewayPostJsonEndpoint", () => {
  it("does not admit a parsed body after its authority was revoked while reading", async () => {
    const body = createDeferred<unknown>();
    const reading = createDeferred();
    const res = Object.assign(response(), { writableEnded: false });
    let current = true;
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValueOnce(
      authorizedRequest({
        hasCurrentClientAuthority: () => current,
        revalidate: async () => {
          if (!current) {
            Object.assign(res, { writableEnded: true });
            throw new Error("Unauthorized");
          }
        },
      }),
    );
    vi.mocked(readJsonBodyOrError).mockImplementationOnce(() => {
      reading.resolve();
      return body.promise;
    });
    const pending = handleEndpoint({ response: res });
    await reading.promise;
    current = false;
    body.resolve({ message: "must not execute" });
    await expect(pending).resolves.toBeUndefined();
  });

  it("returns false when path does not match", async () => {
    const result = await handleEndpoint({ request: { url: "/nope" } });
    expect(result).toBe(false);
  });

  it("returns undefined and replies when method is not POST", async () => {
    const mockedSendMethodNotAllowed = vi.mocked(sendMethodNotAllowed);
    mockedSendMethodNotAllowed.mockClear();
    const result = await handleEndpoint({ request: { method: "GET" } });
    expect(result).toBeUndefined();
    expect(mockedSendMethodNotAllowed).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when auth fails", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(null);
    const result = await handleEndpoint();
    expect(result).toBeUndefined();
  });

  it("returns body when auth succeeds and JSON parsing succeeds", async () => {
    const requestAuth = authorizedRequest();
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(requestAuth);
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ hello: "world" });
    vi.mocked(resolveTrustedHttpOperatorScopes).mockReturnValue(["operator.write"]);
    const result = await handleEndpoint();
    expect(result).toEqual({
      body: { hello: "world" },
      requestAuth,
      operatorScopes: ["operator.write"],
    });
  });

  it("matches paths without trusting malformed Host headers", async () => {
    const requestAuth = authorizedRequest();
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(requestAuth);
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ ok: true });
    vi.mocked(resolveTrustedHttpOperatorScopes).mockReturnValue(["operator.write"]);

    const result = await handleEndpoint({ request: { host: "[" } });

    expect(result).toEqual({
      body: { ok: true },
      requestAuth,
      operatorScopes: ["operator.write"],
    });
  });

  it("returns undefined and replies when required operator scope is missing", async () => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(
      authorizedRequest({ trustDeclaredOperatorScopes: false }),
    );
    vi.mocked(resolveTrustedHttpOperatorScopes).mockReturnValue(["operator.approvals"]);
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({
      allowed: false,
      missingScope: "operator.write",
    });
    const mockedSendMissingScopeForbidden = vi.mocked(sendMissingScopeForbidden);
    mockedSendMissingScopeForbidden.mockClear();
    vi.mocked(readJsonBodyOrError).mockClear();
    const res = response();

    const result = await handleEndpoint({
      response: res,
      endpoint: {
        requiredOperatorMethod: "chat.send",
      },
    });

    expect(result).toBeUndefined();
    expect(vi.mocked(authorizeOperatorScopesForMethod)).toHaveBeenCalledWith("chat.send", [
      "operator.approvals",
    ]);
    expect(mockedSendMissingScopeForbidden).toHaveBeenCalledWith(res, "operator.write");
    expect(vi.mocked(readJsonBodyOrError)).not.toHaveBeenCalled();
  });

  it("uses a custom operator scope resolver when provided", async () => {
    const requestAuth = authorizedRequest({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue(requestAuth);
    vi.mocked(authorizeOperatorScopesForMethod).mockReturnValue({ allowed: true });
    vi.mocked(readJsonBodyOrError).mockResolvedValue({ ok: true });
    const resolveOperatorScopes = vi.fn<NonNullable<EndpointOptions["resolveOperatorScopes"]>>(
      () => ["operator.admin", "operator.write"],
    );

    const result = await handleEndpoint({
      endpoint: {
        requiredOperatorMethod: "chat.send",
        resolveOperatorScopes,
      },
    });

    const [, resolvedAuth] = resolveOperatorScopes.mock.calls.at(0) ?? [undefined, undefined];
    expect(resolvedAuth?.authMethod).toBe("token");
    expect(resolvedAuth?.trustDeclaredOperatorScopes).toBe(false);
    expect(result).toEqual({
      body: { ok: true },
      requestAuth,
      operatorScopes: ["operator.admin", "operator.write"],
    });
  });
});
