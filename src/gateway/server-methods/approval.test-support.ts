import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import * as asyncApprovalStore from "../operator-approval-store.async.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import type { createApprovalHandlers } from "./approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}

export function approvalFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !("approval" in result)) {
    throw new Error("missing approval response");
  }
  return (result as { approval: Record<string, unknown> }).approval;
}

/** A host Date spy does not change the physical worker's clock. */
export function mockApprovalLookupTime(nowMs: number): void {
  const lookup = asyncApprovalStore.getOperatorApprovalDetailedAsync;
  vi.spyOn(asyncApprovalStore, "getOperatorApprovalDetailedAsync").mockImplementation((params) =>
    lookup({ ...params, nowMs }),
  );
}

export function expectSuccessfulApprovalResponses(
  responses: Awaited<ReturnType<typeof invoke>>[],
  context: GatewayRequestHandlerOptions["context"],
): void {
  expect(
    responses.map(({ ok, result, error }) => ({ ok, result, error })),
    JSON.stringify(vi.mocked(context.logGateway.error).mock.calls),
  ).toMatchObject(responses.map(() => ({ ok: true, error: undefined })));
}

export function createClient(params: {
  scopes?: string[];
  deviceId?: string;
  internal?: boolean;
  connId?: string;
}): GatewayRequestHandlerOptions["client"] {
  return {
    connId: params.connId ?? (params.deviceId ? `conn-${params.deviceId}` : "conn-no-device"),
    connect: {
      client: { id: "approval-test", displayName: "Approval Test" },
      scopes: params.scopes ?? ["operator.approvals"],
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.internal ? { internal: { approvalRuntime: true } } : {}),
  } as unknown as GatewayRequestHandlerOptions["client"];
}

export function createContext(
  controlUiBasePath?: string,
  approvalWebPushDelivery?: GatewayRequestHandlerOptions["context"]["approvalWebPushDelivery"],
) {
  const cfg = { gateway: { controlUi: { basePath: controlUiBasePath } } };
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    approvalEvents: {
      publishRequested: vi.fn(() => 0),
      publishResolved: vi.fn(),
    },
    getApprovalClientConnIds: vi.fn(() => new Set(["approval-client"])),
    getRuntimeConfig: () => cfg,
    approvalWebPushDelivery,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

export async function invoke(params: {
  handlers: ReturnType<typeof createApprovalHandlers>;
  method: "approval.get" | "approval.history" | "approval.resolve";
  body: Record<string, unknown>;
  client: GatewayRequestHandlerOptions["client"];
  context?: GatewayRequestHandlerOptions["context"];
}) {
  const respond = vi.fn();
  const context = params.context ?? createContext();
  await expectDefined(
    params.handlers[params.method],
    "params.handlers[params.method] test invariant",
  )({
    req: { id: "req-1", type: "req", method: params.method, params: params.body },
    params: params.body,
    client: params.client,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  const response = respond.mock.calls[0];
  if (!response) {
    throw new Error("approval handler did not respond");
  }
  return { ok: response[0], result: response[1], error: response[2], context };
}
