import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

type ApprovalClientLookup = NonNullable<GatewayRequestContext["getApprovalClientConnIds"]>;

export function createApprovalClient(params: {
  connId: string;
  clientId: string;
  deviceId?: string;
  scopes?: string[];
  approvalRuntime?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: params.clientId },
      device: params.deviceId ? { id: params.deviceId } : undefined,
      scopes: params.scopes ?? ["operator.approvals"],
    },
    ...(params.approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
  } as GatewayClient;
}

export function createApprovalClientLookup(clients: GatewayClient[]): ApprovalClientLookup {
  return (opts = {}) =>
    new Set(
      clients
        .filter((client) => {
          if (opts.excludeConnId && client.connId === opts.excludeConnId) {
            return false;
          }
          return opts.filter?.(client, opts.record) ?? true;
        })
        .map((client) => client.connId)
        .filter((connId): connId is string => typeof connId === "string" && connId.length > 0),
    );
}

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
