import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeGatewayHttpRequestOrReply: vi.fn(),
  resolveSharedSecretHttpOperatorScopes: vi.fn(),
}));

vi.mock("./http-common.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-common.js")>()),
  readJsonBodyOrError: vi.fn(),
  sendMethodNotAllowed: vi.fn(),
  sendMissingScopeForbidden: vi.fn(),
}));

vi.mock("./method-scopes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./method-scopes.js")>()),
  authorizeOperatorScopesForMethod: vi.fn(),
}));

const {
  readJsonBodyOrError: readBody,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} = await import("./http-common.js");
const {
  authorizeGatewayHttpRequestOrReply: authorize,
  resolveSharedSecretHttpOperatorScopes: scopes,
} = await import("./http-utils.js");
const { authorizeOperatorScopesForMethod: authorizeScopes } = await import("./method-scopes.js");

type RequestAuth = NonNullable<Awaited<ReturnType<typeof authorize>>>;

const authorizedRequest = (overrides: Partial<RequestAuth> = {}): RequestAuth => ({
  trustDeclaredOperatorScopes: true,
  hasCurrentClientAuthority: () => true,
  assertCurrent: () => {},
  revalidate: async () => {},
  ...overrides,
});

const handleEndpoint = (
  request: Partial<Pick<IncomingMessage, "url" | "method" | "headers">> = {},
  response = {} as ServerResponse,
) =>
  handleGatewayPostJsonEndpoint(
    {
      url: "/v1/ok",
      method: "POST",
      headers: { host: "localhost" },
      ...request,
    } as IncomingMessage,
    response,
    {
      pathname: "/v1/ok",
      auth: {} as ResolvedGatewayAuth,
      requiredOperatorMethod: "chat.send",
      maxBodyBytes: 123,
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authorizeScopes).mockReturnValue({ allowed: true });
  vi.mocked(scopes).mockReturnValue(["operator.write"]);
});

it("does not admit a parsed body after its authority was revoked while reading", async () => {
  const body = createDeferred<unknown>();
  const reading = createDeferred();
  const res = Object.assign({} as ServerResponse, { writableEnded: false });
  let current = true;
  vi.mocked(authorize).mockResolvedValueOnce(
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
  vi.mocked(readBody).mockImplementationOnce(() => {
    reading.resolve();
    return body.promise;
  });
  const pending = handleEndpoint({}, res);
  await reading.promise;
  current = false;
  body.resolve({ message: "must not execute" });
  await expect(pending).resolves.toBeUndefined();
});

it("returns false when path does not match", async () => {
  expect(await handleEndpoint({ url: "/nope" })).toBe(false);
});

it("returns undefined and replies when method is not POST", async () => {
  expect(await handleEndpoint({ method: "GET" })).toBeUndefined();
  expect(sendMethodNotAllowed).toHaveBeenCalledTimes(1);
});

it("returns undefined when auth fails", async () => {
  vi.mocked(authorize).mockResolvedValue(null);
  expect(await handleEndpoint()).toBeUndefined();
});

it("matches paths without trusting malformed Host headers", async () => {
  const requestAuth = authorizedRequest();
  vi.mocked(authorize).mockResolvedValue(requestAuth);
  vi.mocked(readBody).mockResolvedValue({ ok: true });

  expect(await handleEndpoint({ headers: { host: "[" } })).toEqual({
    body: { ok: true },
    requestAuth,
    operatorScopes: ["operator.write"],
  });
});

it("returns undefined and replies when required operator scope is missing", async () => {
  vi.mocked(authorize).mockResolvedValue(authorizedRequest({ trustDeclaredOperatorScopes: false }));
  vi.mocked(scopes).mockReturnValue(["operator.approvals"]);
  vi.mocked(authorizeScopes).mockReturnValue({
    allowed: false,
    missingScope: "operator.write",
  });
  const res = {} as ServerResponse;

  expect(await handleEndpoint({}, res)).toBeUndefined();
  expect(authorizeScopes).toHaveBeenCalledWith("chat.send", ["operator.approvals"]);
  expect(sendMissingScopeForbidden).toHaveBeenCalledWith(res, "operator.write");
  expect(readBody).not.toHaveBeenCalled();
});
