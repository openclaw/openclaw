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
  const sessionWork = await import("../sessions/session-controller.lifecycle.js");
  const chatModule = selection
    ? undefined
    : await import("./server-methods/chat-send-dispatch-errors.js");
  const execute = executionModule.startAgentRunExecution;
  const handleRequest = requestModule.handleGatewayRequest;
  const retainWork = admission.runWithRetainedGatewayRootWork;
  const continueWork = admission.runWithGatewayIndependentRootWorkContinuation;
  const trackWork = asyncWork.trackAsyncWork;
  const beginSessionWork = sessionWork.beginSessionEffect;
  const rootWorkAdmission = admission.tryBeginGatewayRootWorkAdmission;
  const previousRootWork = vi.isMockFunction(rootWorkAdmission)
    ? rootWorkAdmission.getMockImplementation()
    : undefined;
  const beginRootWork = previousRootWork ?? rootWorkAdmission;
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
      const settled = () => observed.effects.delete(pending);
      void pending.then(settled, settled);
    }
    return pending;
  };
  const rootWorkSpy = vi
    .spyOn(admission, "tryBeginGatewayRootWorkAdmission")
    .mockImplementation((origin) => {
      const lease = beginRootWork(origin);
      const observed = observedRequest.getStore();
      if (!lease?.ownsRoot || !observed) {
        return lease;
      }
      return {
        ...lease,
        run: (run) =>
          lease.run(() => {
            const observeRelease = admission.captureGatewayRootWorkReleaseObserver();
            if (observeRelease) {
              const released = createDeferred();
              observeRelease(() => released.resolve());
              // Only cleanup joins final release; dispatch-only waits must stay nonblocking.
              void captureEffect(released.promise);
            }
            return run();
          }),
      };
    });
  const createChatLifecycle = chatModule?.createChatSendDispatchErrorLifecycle;
  const spies = {
    session: vi.spyOn(sessionWork, "beginSessionEffect").mockImplementation((params) => {
      const pending = beginSessionWork(params);
      if (observedRequest.getStore()) {
        // Queued custody can finish outside the request frame after dispatch settles.
        void captureEffect(pending.then((lease) => lease.released));
      }
      return pending;
    }),
    // Observe persistence and retained work without changing their admission or promises.
    asyncWork: vi
      .spyOn(asyncWork, "trackAsyncWork")
      .mockImplementation((run) => captureEffect(trackWork(run))),
    effect: vi
      .spyOn(admission, "runWithRetainedGatewayRootWork")
      .mockImplementation((run) => captureEffect(retainWork(run))),
    continuation: vi
      .spyOn(admission, "runWithGatewayIndependentRootWorkContinuation")
      .mockImplementation((run, origin) => captureEffect(continueWork(run, origin))),
    request: vi
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
      }),
    execution: vi.spyOn(executionModule, "startAgentRunExecution").mockImplementation((params) => {
      const pending = execute(params);
      observedRequest.getStore()?.executions.push(pending);
      return pending;
    }),
    chat:
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
        : undefined,
  };
  const settleSelected = async (runId?: string, includeEffects = true) => {
    for (const observed of requests) {
      if (runId === undefined || observed.runId === runId) {
        // Admission can register detached execution while the request settles.
        await Promise.allSettled([observed.request]);
        await Promise.allSettled(observed.executions);
        if (includeEffects) {
          while (observed.effects.size > 0) {
            await Promise.allSettled(observed.effects);
          }
        }
      }
    }
  };
  return {
    // Queued custody intentionally retains effects until a later execution settles.
    waitForDispatch: (runId: string) => settleSelected(runId, false),
    waitForCompletion: (runId?: string) => settleSelected(runId),
    async restore() {
      try {
        await settleSelected();
      } finally {
        for (const spy of Object.values(spies)) {
          spy?.mockRestore();
        }
        if (previousRootWork) {
          rootWorkSpy.mockImplementation(previousRootWork);
        } else {
          rootWorkSpy.mockRestore();
        }
        observedRequest.disable();
      }
    },
  };
}

function agentCommandCalls(): Array<[AgentCommandCall]> {
  return vi.mocked(agentCommandMock).mock.calls as unknown as Array<[AgentCommandCall]>;
}

export async function waitForAgentCommandCall(runId: string): Promise<AgentCommandCall> {
  for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) {
    const call = agentCommandCalls().find(([entry]) => entry.runId === runId)?.[0];
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
