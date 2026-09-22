import { onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { HealthSummary } from "../../health/types.js";
import { getGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { createOperatorWsClient } from "./authenticated-request-dispatch.test-support.js";

export type CloseGatewayConnection = (code?: number, reason?: string) => void;
export type SetCloseCause = (cause: string, meta?: Record<string, unknown>) => void;

export function createCloseMock() {
  return vi.fn<CloseGatewayConnection>();
}

export function createSetCloseCauseMock() {
  return vi.fn<SetCloseCause>();
}

export function localUserIngressFor(client: unknown) {
  return typeof client === "object" && client !== null
    ? getGatewayLocalUserIngress(client)
    : undefined;
}

export function useGatewayTestConfig<T>(mock: Mock<() => T>, implementation: () => T) {
  const previous = mock.getMockImplementation();
  onTestFinished(() => {
    if (previous) {
      mock.mockImplementation(previous);
    }
  });
  mock.mockImplementation(implementation);
}

export function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "", count: 0, recent: [] },
  };
}

export function createConnectedTestClient(params: {
  connId: string;
  invalidated?: boolean;
  invalidatedReason?: string;
}) {
  return {
    ...createOperatorWsClient({
      connId: params.connId,
      clientInfo: { id: "openclaw-control-ui", mode: "ui" },
      scopes: [],
    }),
    invalidated: params.invalidated ?? false,
    ...(params.invalidatedReason ? { invalidatedReason: params.invalidatedReason } : {}),
  };
}

export function createGatewayAttachmentCompletion(connId: string, warnings: () => unknown) {
  const completion = createDeferred();
  void completion.promise.catch(() => {});
  return {
    promise: completion.promise,
    attached(callback?: () => void) {
      try {
        callback?.();
        completion.resolve();
      } catch (error) {
        completion.reject(error);
        throw error;
      }
    },
    closed(code?: number, reason?: string) {
      completion.reject(
        new Error(
          `Connection ${connId} closed before attachment: ${code ?? "no code"} ${reason ?? "no reason"}; warnings=${JSON.stringify(warnings())}`,
        ),
      );
    },
  };
}
