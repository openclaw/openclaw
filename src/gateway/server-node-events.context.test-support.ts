import { expect, vi } from "vitest";
import type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.js";
import {
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { HealthSummary } from "./health/types.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

export function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

export function eventResult(event: string, reason: string, handled = false) {
  return { ok: true, event, handled, reason };
}

export function waitForFast<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 1 });
}

export async function runAdmittedNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: Parameters<typeof handleNodeEvent>[2],
): Promise<void> {
  const admission = tryBeginGatewayRootWorkAdmission();
  expect(admission).not.toBeNull();
  try {
    await admission?.run(() => handleNodeEvent(ctx, nodeId, event));
  } finally {
    admission?.release();
  }
}

export function expectSuspendBusyWithRootWork(requestId: string): void {
  expect(
    prepareGatewaySuspend({
      requestId,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
    }),
  ).toMatchObject({
    status: "busy",
    blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request", count: 1 })]),
  });
}

export function expectSuspendReady(requestId: string): void {
  const result = prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
  });
  expect(result).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  if (result.status === "ready") {
    expect(resumeGatewaySuspend(result.suspensionId)).toMatchObject({
      ok: true,
      status: "running",
      resumed: true,
    });
  }
}

export function buildCtx(
  opts: { authorizeNodeSystemRunEvent?: NodeEventContext["authorizeNodeSystemRunEvent"] } = {},
): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    authorizeNodeSystemRunEvent: opts.authorizeNodeSystemRunEvent ?? (() => false),
    logGateway: { warn: () => {} },
  };
}

export function presenceConnection(deviceId: string, generation = `${deviceId}-generation`) {
  return {
    deviceId,
    pairingGeneration: { nodeId: deviceId, key: generation },
  };
}

export const directRegistration = {
  token: "abcd1234abcd1234abcd1234abcd1234",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
};
export const relayRegistration = {
  transport: "relay",
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  installationId: "install-123",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  distribution: "official",
  tokenDebugSuffix: "abcd1234",
};

export const sentDurableMessageBatchResult: Extract<
  DurableMessageBatchSendResult,
  { status: "sent" }
> = {
  status: "sent",
  results: [],
  receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
};
