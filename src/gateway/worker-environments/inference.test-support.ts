import { vi } from "vitest";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { WorkerConnectionIdentity, WorkerInferenceExecutor } from "./connection-identity.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager, type WorkerInferenceSink } from "./inference.js";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "s",
  runId: "r",
  turnId: "t",
  modelRef: { provider: "p", model: "m" },
  context: { messages: [] },
  options: {},
};
const { runEpoch, sessionId, runId, turnId, modelRef } = REQUEST;
export const SESSION_TARGET = {
  agentId: "main",
  sessionId,
  sessionKey: "agent:main:inference",
  storePath: "inference-sessions.sqlite",
};
export const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "w",
  credentialHash: "d",
  bundleHash: "b",
  sessionId,
  runId,
  turnClaim: {
    sessionId,
    claimId: "claim-r",
    runId,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "w", ownerEpoch: runEpoch },
  },
  ownerEpoch: runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 10_000,
};
export const ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};
export const DONE: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: makeAgentAssistantMessage({
    content: [{ type: "text", text: "done" }],
    ...modelRef,
    usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
    timestamp: 1,
  }),
};
export const CANCEL = { runEpoch, sessionId, runId, turnId };

export function identityFor(request: WorkerInferenceStartParams): WorkerConnectionIdentity {
  return {
    ...IDENTITY,
    sessionId: request.sessionId,
    runId: request.runId,
    turnClaim: {
      ...IDENTITY.turnClaim!,
      sessionId: request.sessionId,
      runId: request.runId,
      claimId: `claim-${request.runId}`,
    },
  };
}

export type Manager = ReturnType<typeof createWorkerInferenceManager>;
type StartOverrides = {
  identity?: WorkerConnectionIdentity;
  request?: WorkerInferenceStartParams;
  sink?: WorkerInferenceSink;
  revalidate?: () => "epoch-mismatch" | null;
};

export function createMemoryStore(): WorkerInferenceStore {
  return {
    begin: async () => ({ kind: "claimed" }),
    complete: async (input) => input.outcome,
    async cancelPending() {},
    async recoverPending() {},
  };
}

export function createSink(connectionId = "c") {
  const frames: Parameters<WorkerInferenceSink["send"]>[0][] = [];
  const terminal = createDeferred<WorkerInferenceTerminalFrame>();
  const sink: WorkerInferenceSink = {
    connectionId,
    send: (frame) => {
      frames.push(frame);
      if (frame.event === "worker.inference.terminal") {
        terminal.resolve(frame);
      }
    },
  };
  return { frames, sink, terminal: terminal.promise };
}

export function terminalFrames(frames: Parameters<WorkerInferenceSink["send"]>[0][]) {
  return frames.filter(
    (frame): frame is WorkerInferenceTerminalFrame => frame.event === "worker.inference.terminal",
  );
}

export async function accept(manager: Manager, overrides: StartOverrides = {}, launch = true) {
  const result = await manager.start({
    sessionTarget: SESSION_TARGET,
    identity: IDENTITY,
    request: REQUEST,
    sink: createSink().sink,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}`);
  }
  if (launch) {
    result.launch();
  }
  return result;
}

export function makeManager(execute: WorkerInferenceExecutor, store = createMemoryStore()) {
  return createWorkerInferenceManager({ execute, store });
}
