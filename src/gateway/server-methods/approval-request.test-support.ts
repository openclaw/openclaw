import { expect } from "vitest";
import {
  awaitGateBeforeSettlement as awaitGate,
  createDeferred,
} from "../../../test/helpers/promise.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

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
      clients.flatMap((client) =>
        (opts.excludeConnId && client.connId === opts.excludeConnId) ||
        !(opts.filter?.(client, opts.record) ?? true) ||
        typeof client.connId !== "string" ||
        !client.connId.length
          ? []
          : [client.connId],
      ),
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
  const { broadcast, broadcastToConnIds } = context;
  const observe =
    <Args extends [string, unknown?, ...unknown[]]>(send: (...args: Args) => void) =>
    (...args: Args) => {
      send.call(context, ...args);
      if (args[0] === eventName) {
        observed.resolve(args[1]);
      }
    };
  context.broadcast = observe(broadcast);
  if (broadcastToConnIds) {
    context.broadcastToConnIds = observe(broadcastToConnIds);
  }
  try {
    const pending = start();
    const payload = await awaitGate(observed.promise, pending, "Approval ended before event");
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
  respond: RespondFn,
  start: (respond: RespondFn) => Promise<T>,
) {
  const firstResponse = createDeferred<Parameters<typeof respond>>();
  const pending = start((...response) => {
    respond(...response);
    firstResponse.resolve(response);
  });
  const response = await awaitGate(
    firstResponse.promise,
    pending,
    "Approval ended before acceptance",
  );
  expect(response[0]).toBe(true);
  expect(response[1]).toMatchObject({ status: "accepted", id: expect.any(String) });
  expect(response[2]).toBeUndefined();
  return { pending, response };
}
