import { captureOperatorToolGatewayContinuationContext } from "../gateway/server-plugin-in-process-dispatch.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import {
  assertAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "./agent-harness-task-runtime-scope.js";
import { matchesTaskPersistenceReceipt } from "./task-registry-records.js";
import { getTasksByRunId } from "./task-registry-state.js";
import type { TaskPersistenceReceipt } from "./task-registry.types.js";

/** A host-issued hold on one requester's accepted completion work, never arbitrary tools. */
export type AgentHarnessCompletionCustody = {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  retain(): AgentHarnessCompletionCustody;
  /** End native execution custody after terminal persistence, without losing delivery authority. */
  settleExecution(): void;
  release(): void;
};

type CompletionOwner = {
  scope: AgentHarnessTaskRuntimeScope;
  run: <T>(run: () => T) => T;
  emit: (run: () => void) => void;
};
const registryKey = Symbol.for("openclaw.agentHarnessCompletionCustody.registry");
// SAFETY: This module owns the process-global symbol and initializes only this typed WeakMap.
const globalRegistry = globalThis as typeof globalThis & {
  [registryKey]?: WeakMap<AgentHarnessCompletionCustody, CompletionOwner>;
};
const owners = (globalRegistry[registryKey] ??= new WeakMap());

function getCompletionOwner(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessTaskRuntimeScope,
) {
  const owner = owners.get(custody);
  const expected = owner && getGatewayContextResolver(owner.scope);
  const actual = getGatewayContextResolver(scope);
  if (
    !owner ||
    owner.scope.requesterSessionKey !== scope.requesterSessionKey ||
    (expected && getCanonicalGatewayContextResolver(expected)) !==
      (actual && getCanonicalGatewayContextResolver(actual))
  ) {
    throw new Error("Harness completion custody does not own this requester");
  }
  return owner;
}

/** Capture during admission; assignment/recovery owners retain their own holds before yielding. */
export function captureAgentHarnessCompletionCustodyOwner(
  scopeInput: AgentHarnessTaskRuntimeScope,
  assertRequesterCurrent: () => void,
): AgentHarnessCompletionCustody | undefined {
  const scope = assertAgentHarnessTaskRuntimeScope(scopeInput);
  const resolver = getGatewayContextResolver(scope);
  const captured = resolver
    ? withPluginRuntimeGatewayContextResolver(
        resolver,
        captureOperatorToolGatewayContinuationContext,
      )
    : captureOperatorToolGatewayContinuationContext();
  if (!captured) {
    return undefined;
  }
  const root = retainGatewayRootWorkAdmissionContinuationScope();
  const releaseRoot = () => root?.release();
  captured.signal.addEventListener("abort", releaseRoot, { once: true });
  let references = 0;
  let executions = 0;
  const retain = (settled = false): AgentHarnessCompletionCustody => {
    captured.signal.throwIfAborted();
    references += 1;
    if (!settled) {
      executions += 1;
    }
    const lifetime = new AbortController();
    let executionSettled = settled;
    const settleExecution = () => {
      if (!executionSettled) {
        executionSettled = true;
        if (--executions === 0) {
          captured.signal.removeEventListener("abort", releaseRoot);
          releaseRoot();
        }
      }
    };
    const assertCurrent = () => {
      lifetime.signal.throwIfAborted();
      captured.signal.throwIfAborted();
      assertRequesterCurrent();
    };
    const custody: AgentHarnessCompletionCustody = {
      signal: AbortSignal.any([lifetime.signal, captured.signal]),
      isCurrent: () => isAgentHarnessCompletionCustodyCurrent(custody, scope),
      retain() {
        assertCurrent();
        return retain(executionSettled);
      },
      settleExecution,
      release() {
        if (lifetime.signal.aborted) {
          return;
        }
        lifetime.abort(new Error("Harness completion custody was released"));
        settleExecution();
        if (--references === 0) {
          captured.release();
        }
      },
    };
    owners.set(custody, {
      scope,
      run(run) {
        assertCurrent();
        return !executionSettled && root
          ? root.runSync(() => captured.run(run))
          : captured.run(run);
      },
      emit(run) {
        assertCurrent();
        if (executionSettled) {
          throw new Error("Harness execution custody was settled");
        }
        captured.run(() => (root ? root.runSync(run) : run()));
      },
    });
    return custody;
  };
  try {
    return retain();
  } catch (error) {
    root?.release();
    captured.release();
    throw error;
  }
}

/** Binds an event producer to one persisted assignment; no caller-supplied event routing escapes. */
export function createAgentHarnessTaskEventSink(params: {
  scope: AgentHarnessTaskRuntimeScope;
  completionCustody: AgentHarnessCompletionCustody;
  runId: string;
  expectedTask: TaskPersistenceReceipt;
}): (event: Pick<Parameters<typeof emitAgentEvent>[0], "stream" | "data">) => void {
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const owner = getCompletionOwner(params.completionCustody, scope);
  const readTasks = () =>
    getTasksByRunId(params.runId).filter(
      (task) =>
        task.runtime === "subagent" &&
        Boolean(task.taskKind) &&
        task.requesterSessionKey === scope.requesterSessionKey &&
        task.scopeKind === "session" &&
        task.ownerKey === scope.requesterSessionKey,
    );
  if (
    params.expectedTask.runId !== params.runId ||
    params.expectedTask.runtime !== "subagent" ||
    !params.expectedTask.taskKind ||
    params.expectedTask.scopeKind !== "session" ||
    params.expectedTask.ownerKey !== scope.requesterSessionKey
  ) {
    throw new Error("Harness event custody does not own this task assignment");
  }
  const generation = getAgentEventLifecycleGeneration();
  return (event) =>
    owner.emit(() => {
      const current = readTasks();
      if (
        current.length !== 1 ||
        !current[0] ||
        !matchesTaskPersistenceReceipt(current[0], params.expectedTask)
      ) {
        throw new Error("Harness event task assignment was replaced");
      }
      emitAgentEvent({
        stream: event.stream,
        data: event.data,
        runId: params.runId,
        agentId: current[0].agentId,
        lifecycleGeneration: generation,
      });
    });
}

/** Only the completion SDK can enter retained authority; plugins cannot execute a callback in it. */
export function runWithAgentHarnessCompletionCustody<T>(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessTaskRuntimeScope,
  run: () => T,
): T {
  const owner = getCompletionOwner(custody, scope);
  return owner.run(run);
}

/** Revalidate the retained source at asynchronous delivery effect boundaries. */
export function isAgentHarnessCompletionCustodyCurrent(
  custody: AgentHarnessCompletionCustody,
  scope: AgentHarnessTaskRuntimeScope,
): boolean {
  try {
    return getCompletionOwner(custody, scope).run(() => true);
  } catch {
    return false;
  }
}
