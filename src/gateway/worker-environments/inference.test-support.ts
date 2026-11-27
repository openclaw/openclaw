import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { WorkerConnectionIdentity, WorkerInferenceExecutor } from "./connection-identity.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager, type WorkerInferenceSink } from "./inference.js";

export { waitForFast } from "../../../test/helpers/vitest-wait.js";

export const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "s",
  runId: "r",
  turnId: "t",
  modelRef: { provider: "p", model: "m" },
  context: { messages: [] },
  options: {},
};
const { runEpoch, sessionId: session, runId: run, turnId, modelRef } = REQUEST;
export const SESSION_TARGET = {
  agentId: "main",
  sessionId: session,
  sessionKey: "agent:main:inference",
  storePath: "inference-sessions.sqlite",
};
export const IDENTITY = identityFor(REQUEST);
export const ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};
export const DONE: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    role: "assistant",
    api: "openai-responses",
    content: [{ type: "text", text: "done" }],
    ...modelRef,
    usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp: 1,
  },
};
export const CANCEL = { runEpoch, sessionId: session, runId: run, turnId };

export function identityFor({
  sessionId,
  runId,
}: WorkerInferenceStartParams): WorkerConnectionIdentity {
  const turnClaim: NonNullable<WorkerConnectionIdentity["turnClaim"]> = {
    sessionId,
    runId,
    claimId: `claim-${runId}`,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "w", ownerEpoch: runEpoch },
  };
  return createWorkerConnectionIdentity(turnClaim, {
    credentialHash: "d",
    bundleHash: "b",
    protocolFeatures: ["worker-inference-v1"],
  });
}

export type Manager = ReturnType<typeof createWorkerInferenceManager>;
type StartOverrides = {
  identity?: WorkerConnectionIdentity;
  request?: WorkerInferenceStartParams;
  sink?: WorkerInferenceSink;
  revalidate?: () => "epoch-mismatch" | null;
};

export const createMemoryStore = (): WorkerInferenceStore => ({
  begin: async () => ({ kind: "claimed" }),
  complete: async (input) => input.outcome,
  async cancelPending() {},
  async recoverPending() {},
});

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

export const terminalFrames = (frames: Parameters<WorkerInferenceSink["send"]>[0][]) =>
  frames.filter(
    (frame): frame is WorkerInferenceTerminalFrame => frame.event === "worker.inference.terminal",
  );

export function startInference(
  instance: Manager,
  overrides: Partial<Parameters<Manager["start"]>[0]> = {},
) {
  return instance.start({
    identity: IDENTITY,
    request: REQUEST,
    sessionTarget: SESSION_TARGET,
    sink: overrides.sink ?? createSink().sink,
    ...overrides,
  });
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

export const makeManager = (execute: WorkerInferenceExecutor, store = createMemoryStore()) =>
  createWorkerInferenceManager({ execute, store });
