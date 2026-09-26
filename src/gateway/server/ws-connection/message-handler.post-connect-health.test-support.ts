import { onTestFinished, vi, type Mock } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticSecurityEvent,
} from "../../../infra/diagnostic-events.js";
import { mintAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import type { HealthSummary } from "../../health/types.js";
import { getGatewayLocalUserIngress } from "../../local-user-ingress.js";
import { createOperatorWsClient } from "./authenticated-request-dispatch.test-support.js";

export type CloseGatewayConnection = (code?: number, reason?: string) => void;
export type SetCloseCause = (cause: string, meta?: Record<string, unknown>) => void;

export const DEVICE_TOKEN_MUTATION_PARAMS = {
  deviceId: "device-1",
  role: "operator",
} as const satisfies Record<string, unknown>;
export const NODE_PAIR_REMOVE_PARAMS = {
  nodeId: "device-1",
} as const satisfies Record<string, unknown>;
export const BACKEND_CONNECT_PARAMS = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: "gateway-client",
    version: "dev",
    platform: "test",
    mode: "backend",
  },
  role: "operator",
  caps: [],
} as const satisfies Record<string, unknown>;

export function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

export function createCloseMock() {
  return vi.fn<CloseGatewayConnection>();
}

export async function createTestAgentRuntimeIdentityLease() {
  const prepared = prepareSystemAgentRunAdmission(
    {},
    "run-1",
    "ops",
    "message-handler.post-connect-health.test",
  );
  await prepared.admit("embedded");
  onTestFinished(prepared.close);
  return {
    close: prepared.close,
    token: await mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:telegram:direct:alice",
      operationalRunInstance: prepared.operationalRunInstance,
    }),
  };
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
