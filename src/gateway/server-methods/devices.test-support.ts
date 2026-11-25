import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createInfoWarnErrorDebugLogger } from "../../../test/helpers/mock-logger.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  pairing: {
    getPairedDevice: vi.fn(),
    getPendingDevicePairing: vi.fn(),
    listDevicePairing: vi.fn(),
    removePairedDevice: vi.fn(),
    rejectDevicePairing: vi.fn(),
    updatePairedDeviceMetadata: vi.fn(),
  },
  approval: { approveDevicePairing: vi.fn() },
  tokens: { revokeDeviceToken: vi.fn(), rotateDeviceToken: vi.fn() },
}));
export { mocks };
vi.mock("../../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing.js")>()),
  ...mocks.pairing,
}));

vi.mock("../../infra/device-pairing-approval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-approval.js")>()),
  ...mocks.approval,
}));

vi.mock("../../infra/device-pairing-tokens.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-tokens.js")>()),
  ...mocks.tokens,
}));

const { deviceHandlers } = await import("./devices.js");

export function createClient(
  scopes: string[],
  deviceId?: string,
  opts?: { isDeviceTokenAuth?: boolean },
) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

export function createOptions(
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"] = null,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      disconnectClientsForDevice: vi.fn(),
      invalidateClientsForDevice: vi.fn(),
      logGateway: createInfoWarnErrorDebugLogger(),
      nodeRegistry: { updateSurface: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

export function createDeviceClient(scopes = ["operator.pairing"], deviceId = "device-1") {
  return createClient(scopes, deviceId, { isDeviceTokenAuth: true });
}

export function expectDeviceSuccess(opts: GatewayRequestHandlerOptions, payload: unknown) {
  expect(opts.respond).toHaveBeenCalledWith(true, payload, undefined);
}

export async function invokeDevice(opts: GatewayRequestHandlerOptions) {
  await expectDefined(deviceHandlers[opts.req.method], opts.req.method)(opts);
}

export function expectPrivate(events: unknown, secrets: string[]) {
  const text = JSON.stringify(events);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

export function mockRotateOperatorTokenSuccess(): void {
  mocks.tokens.rotateDeviceToken.mockResolvedValue({
    ok: true,
    entry: {
      token: "new-token",
      role: "operator",
      scopes: ["operator.pairing"],
      createdAtMs: 456,
      rotatedAtMs: 789,
    },
  });
}

export function expectDeviceError(opts: GatewayRequestHandlerOptions, message: string): void {
  expect(opts.respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({ message }),
  );
}

export async function captureSecurityEvents(run: () => Promise<unknown>) {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  try {
    await run();
    return events;
  } finally {
    stop();
  }
}

export function resetDeviceHandlerTestState(): void {
  resetDiagnosticEventsForTest();
  resetNodeWakeStateForTest();
  vi.clearAllMocks();
}
