import { expect, it } from "vitest";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { prepareAuthenticatedProfile } from "./users-profile-access.js";

function clientWith(signal: AbortSignal): GatewayWsClient {
  return {
    connId: "conn-1",
    connect: { role: "operator", scopes: ["operator.read"] },
    connectionSignal: signal,
    invalidated: false,
  } as unknown as GatewayWsClient;
}

function optionsFor(client: GatewayWsClient): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "models.list", params: {} },
    params: {},
    respond: () => {},
    client,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => ({}) } as never,
  } as GatewayRequestHandlerOptions;
}

it("classifies a closed connection as a cancelled request, not a requester-profile change", async () => {
  const controller = new AbortController();
  const client = clientWith(controller.signal);
  const options = optionsFor(client);

  controller.abort(new Error("connection closed"));

  const error = await prepareAuthenticatedProfile(options).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect((error as Error | undefined)?.name).toBe("GatewayRequestCancelledError");
  expect((error as Error | undefined)?.message).toBe(
    "Gateway request cancelled: connection closed",
  );
});

it("still reports a real requester-profile change after the connection stays open", async () => {
  const controller = new AbortController();
  const client = clientWith(controller.signal);
  // No verified profile yet, so the legacy email path awaits a profile alias lookup between
  // the first and second connection assertions.
  (client as { authenticatedUserId?: string }).authenticatedUserId = "person@example.test";
  const options = optionsFor(client);
  const original = prepareAuthenticatedProfile(options);

  // A real actor swap while the first read is in flight, with the transport still open.
  (client as { authenticatedUserId?: string }).authenticatedUserId = "other@example.test";

  const error = await original.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect((error as Error | undefined)?.name).toBe("Error");
  expect((error as Error | undefined)?.message).toBe("Gateway requester profile changed");
});
