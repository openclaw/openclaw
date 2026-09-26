// Gateway agent-command test helpers.
// Waits for mocked agent command dispatches in async gateway tests.
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sleep } from "../utils/sleep.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

type AgentCommandCall = Record<string, unknown>;

/** Joins selected Gateway requests, detached execution, and tracked async effects. */
export async function observeGatewayRunExecution(selection?: { method: "agent"; runId: string }) {
  const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
  const requestModule = await import("./server-methods.js");
  const admission = await import("../process/gateway-work-admission.js");
  const asyncWork = await import("../shared/async-work-scope.js");
  const chatModule = selection
    ? undefined
    : await import("./server-methods/chat-send-dispatch-errors.js");
  const execute = executionModule.startAgentRunExecution;
  const handleRequest = requestModule.handleGatewayRequest;
  const retainWork = admission.runWithRetainedGatewayRootWork;
  const continueWork = admission.runWithGatewayIndependentRootWorkContinuation;
  const trackWork = asyncWork.trackAsyncWork;
  type ObservedRequest = {
    runId?: string;
    request?: Promise<void>;
    executions: Promise<void>[];
    effects: Set<Promise<unknown>>;
  };
  const requests: ObservedRequest[] = [];
  const observedRequest = new AsyncLocalStorage<ObservedRequest>();
  const captureEffect = <T>(pending: Promise<T>): Promise<T> => {
    const observed = observedRequest.getStore();
    if (observed) {
      observed.effects.add(pending);
      void pending.then(
        () => observed.effects.delete(pending),
        () => observed.effects.delete(pending),
      );
    }
    return pending;
  };
  // Best-effort participant persistence is request-owned async work, not a
  // retained Gateway root. Observe its existing promise without changing admission.
  const observeAsyncWork: typeof trackWork = (run) => captureEffect(trackWork(run));
  const asyncWorkSpy = vi.spyOn(asyncWork, "trackAsyncWork").mockImplementation(observeAsyncWork);
  const observeEffect: typeof retainWork = (run) => captureEffect(retainWork(run));
  const effectSpy = vi
    .spyOn(admission, "runWithRetainedGatewayRootWork")
    .mockImplementation(observeEffect);
  const observeContinuation: typeof continueWork = (run, origin) =>
    captureEffect(continueWork(run, origin));
  const continuationSpy = vi
    .spyOn(admission, "runWithGatewayIndependentRootWorkContinuation")
    .mockImplementation(observeContinuation);
  const requestSpy = vi
    .spyOn(requestModule, "handleGatewayRequest")
    .mockImplementation((options, diagnostics) => {
      const params = isRecord(options.req.params) ? options.req.params : undefined;
      const runId = params?.idempotencyKey ?? params?.runId;
      const selected = selection
        ? options.req.method === selection.method && params?.idempotencyKey === selection.runId
        : true;
      if (!selected) {
        return handleRequest(options, diagnostics);
      }
      const observed: ObservedRequest = {
        runId: typeof runId === "string" ? runId : undefined,
        executions: [],
        effects: new Set(),
      };
      requests.push(observed);
      observed.request = observedRequest.run(observed, () => handleRequest(options, diagnostics));
      return observed.request;
    });
  const executionSpy = vi
    .spyOn(executionModule, "startAgentRunExecution")
    .mockImplementation((params) => {
      const pending = execute(params);
      observedRequest.getStore()?.executions.push(pending);
      return pending;
    });
  const createChatLifecycle = chatModule?.createChatSendDispatchErrorLifecycle;
  const chatSpy =
    chatModule && createChatLifecycle
      ? vi
          .spyOn(chatModule, "createChatSendDispatchErrorLifecycle")
          .mockImplementation((params) => {
            const lifecycle = createChatLifecycle(params);
            const observed = observedRequest.getStore();
            if (!observed) {
              return lifecycle;
            }
            const completed = createDeferred();
            observed.executions.push(completed.promise);
            void completed.promise.catch(() => undefined);
            return {
              ...lifecycle,
              finalize() {
                const pending = lifecycle.finalize();
                // Adopt the original promise without replacing the caller's continuation.
                completed.resolve(pending);
                return pending;
              },
            };
          })
      : undefined;
  const settleRequest = async (observed: ObservedRequest) => {
    // RPC responses and final events assert outcomes; cleanup observes settlement.
    await Promise.allSettled([observed.request]);
    // Request admission can register detached execution after cleanup starts.
    await Promise.allSettled(observed.executions);
    while (observed.effects.size > 0) {
      await Promise.allSettled(observed.effects);
    }
  };
  return {
    async waitForCompletion(runId?: string) {
      for (const observed of requests) {
        if (runId !== undefined && observed.runId !== runId) {
          continue;
        }
        await settleRequest(observed);
      }
    },
    async restore() {
      try {
        for (const observed of requests) {
          await settleRequest(observed);
        }
      } finally {
        chatSpy?.mockRestore();
        asyncWorkSpy.mockRestore();
        executionSpy.mockRestore();
        requestSpy.mockRestore();
        effectSpy.mockRestore();
        continuationSpy.mockRestore();
        observedRequest.disable();
      }
    },
  };
}

function agentCommandCalls(): Array<[AgentCommandCall]> {
  return vi.mocked(agentCommandMock).mock.calls as unknown as Array<[AgentCommandCall]>;
}

/** Waits until the mocked `agentCommand` receives a call for a specific run id. */
export async function waitForAgentCommandCall(runId: string): Promise<AgentCommandCall> {
  for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) {
    const call = agentCommandCalls()
      .map((entry) => entry[0])
      .find((entry) => entry.runId === runId);
    if (call) {
      return call;
    }
    await sleep(5);
  }
  throw new Error(`expected agentCommand to be called for ${runId}`);
}

/** Reads the latest mocked `agentCommand` call, or waits for a specific run id. */
export async function readAgentCommandCall(
  params: { runId?: string; fromEnd?: number } = {},
): Promise<AgentCommandCall> {
  if (params.runId) {
    return await waitForAgentCommandCall(params.runId);
  }
  return agentCommandCalls().at(-(params.fromEnd ?? 1))?.[0] ?? {};
}
