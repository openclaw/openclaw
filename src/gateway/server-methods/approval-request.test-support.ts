import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

/** Install before starting: a previous request's publication cannot admit the next one. */
export async function waitForApprovalRequested<T>(
  context: Pick<GatewayRequestContext, "broadcast"> &
    Partial<Pick<GatewayRequestContext, "broadcastToConnIds">>,
  eventName: string,
  start: () => Promise<T>,
) {
  const observed = createDeferred<unknown>();
  const broadcast = context.broadcast;
  const broadcastToConnIds = context.broadcastToConnIds;
  context.broadcast = (...args) => {
    broadcast.call(context, ...args);
    if (args[0] === eventName) {
      observed.resolve(args[1]);
    }
  };
  if (broadcastToConnIds) {
    context.broadcastToConnIds = (...args) => {
      broadcastToConnIds.call(context, ...args);
      if (args[0] === eventName) {
        observed.resolve(args[1]);
      }
    };
  }
  try {
    const pending = start();
    const payload = await Promise.race([
      observed.promise,
      pending.then(() => {
        throw new Error("Approval request completed before the expected RPC event");
      }),
    ]);
    return { pending, payload };
  } finally {
    context.broadcast = broadcast;
    if (broadcastToConnIds) {
      context.broadcastToConnIds = broadcastToConnIds;
    }
  }
}

/** Capture the first response; the same callback later receives the decision. */
export async function waitForApprovalAccepted<T>(
  respond: GatewayRequestHandlerOptions["respond"],
  start: (respond: GatewayRequestHandlerOptions["respond"]) => Promise<T>,
) {
  const firstResponse = createDeferred<Parameters<typeof respond>>();
  const pending = start((...response) => {
    respond(...response);
    firstResponse.resolve(response);
  });
  const response = await Promise.race([
    firstResponse.promise,
    pending.then(() => {
      throw new Error("Approval request ended before acceptance");
    }),
  ]);
  expect(response[0]).toBe(true);
  expect(response[1]).toMatchObject({ status: "accepted", id: expect.any(String) });
  expect(response[2]).toBeUndefined();
  return { pending, response };
}
