import { vi } from "vitest";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";

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
export const SESSION_TARGET = {
  agentId: "main",
  sessionId: REQUEST.sessionId,
  sessionKey: "agent:main:inference",
  storePath: "inference-sessions.sqlite",
};
export const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "w",
  credentialHash: "d",
  bundleHash: "b",
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnClaim: {
    sessionId: REQUEST.sessionId,
    claimId: "claim-r",
    runId: REQUEST.runId,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "w", ownerEpoch: REQUEST.runEpoch },
  },
  ownerEpoch: REQUEST.runEpoch,
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
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: REQUEST.modelRef.provider,
    model: REQUEST.modelRef.model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
};
export const CANCEL = {
  runEpoch: REQUEST.runEpoch,
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
};

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
