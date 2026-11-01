import { vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";

type Request = Parameters<typeof handleGatewayRequest>[0];
type Client = NonNullable<Request["client"]>;

export function startExactAuthorizationRequest(
  method: string,
  params: unknown,
  options: Omit<Request, "req" | "respond" | "isWebchatConnect">,
  id = method,
) {
  const respond = vi.fn();
  const request = handleGatewayRequest({
    ...options,
    req: { type: "req", id, method, params },
    respond,
    isWebchatConnect: () => false,
  });
  return { request, respond };
}

export async function dispatchAuthorizationRequest(
  ...args: Parameters<typeof startExactAuthorizationRequest>
) {
  const { request, respond } = startExactAuthorizationRequest(...args);
  await request;
  return respond;
}

type AuthorizationRequestOptions = Partial<
  Omit<Request, "req" | "context" | "respond" | "isWebchatConnect">
> & {
  scopes?: string[];
  connId?: string;
  connect?: Partial<Client["connect"]>;
  context?: Partial<Omit<Request["context"], "nodeRegistry">> & {
    nodeRegistry?: Partial<Request["context"]["nodeRegistry"]>;
  };
};

export function authorizationClient(
  connId: string,
  scopes: string[],
  identity: Partial<Client> = {},
  connect: Partial<Client["connect"]> = {},
): Client {
  return {
    connId,
    ...identity,
    connect: {
      role: "operator",
      scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
      ...connect,
    },
  } as Client;
}

export function startAuthorizationRequest(
  method: string,
  params: unknown,
  {
    scopes = ["operator.write"],
    connId = "conn-proof",
    connect,
    context,
    ...options
  }: AuthorizationRequestOptions = {},
) {
  return startExactAuthorizationRequest(method, params, {
    client: authorizationClient(connId, scopes, {}, connect),
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      ...context,
    } as Request["context"],
    ...options,
  });
}

export async function sendAuthorizationRequest(
  method: string,
  params: unknown,
  options: AuthorizationRequestOptions = {},
) {
  const { request, respond } = startAuthorizationRequest(method, params, {
    ...options,
    connect: {
      client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
      ...options.connect,
    },
  });
  await request;
  return respond;
}
