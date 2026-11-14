import { expect, it } from "vitest";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import type { RespondFn } from "./response-types.js";
import { usersHandlers } from "./users.js";

it("settles a closed-connection users.self request as cancelled instead of a profile-change failure", async () => {
  const controller = new AbortController();
  const client = {
    ...createOperatorClient({ profileId: "profile-cancelled", scopes: ["operator.read"] }),
    connectionSignal: controller.signal,
  };
  const respond = () => {};
  const request = handleGatewayRequest({
    req: { type: "req", id: "req-cancel", method: "users.self", params: {} },
    respond: respond as RespondFn,
    context: createContext(),
    client,
    isWebchatConnect: () => false,
    extraHandlers: usersHandlers,
  });

  // The phone goes to background and drops its socket while the handler is preparing authority.
  controller.abort(new Error("connection closed"));

  const error = await request.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect((error as Error | undefined)?.name).toBe("GatewayRequestCancelledError");
  expect((error as Error | undefined)?.message).not.toContain("profile changed");
});
