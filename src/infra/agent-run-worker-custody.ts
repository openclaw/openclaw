import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";
import type {
  AgentRunContext,
  AgentRunRegistryState,
  AgentRunWorkerCustody,
  AgentRunWorkerTransactionSource,
} from "./agent-run-registry.types.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";

type AgentRunWorkerRegistryAccess = {
  getState(): AgentRunRegistryState;
  validateAuthority(authority: AgentRunDelegatedAuthority): boolean;
  getOwnerStatus(
    runId: string,
    claimId: string,
    lifecycleGeneration: string,
  ): "active" | "clear-requested" | undefined;
};

export function retireAgentRunWorkerCustody(context: AgentRunContext): void {
  if (context.workerCustody) {
    context.workerCustody.admissionClosed = true;
  }
}

/** Operations over the registry's original records; this leaf owns no separate state. */
export function createAgentRunWorkerCustodyOperations(access: AgentRunWorkerRegistryAccess) {
  /** Bind before admission callbacks yield, so Gateway retirement can seal future captures. */
  function bindAgentRunWorkerAdmissionOwner(
    authority: AgentRunDelegatedAuthority,
    admittedContext: object,
  ): void {
    const context = access.getState().contexts.get(authority.operationalRunInstance.runId);
    if (context?.delegatedAuthority !== authority) {
      throw new Error("Agent run worker owner no longer holds its admitted authority");
    }
    if (context.workerCustody?.authority === authority) {
      if (context.workerCustody.admittedContext !== admittedContext) {
        throw new Error("Agent run worker authority already belongs to another admitted context");
      }
      return;
    }
    context.workerCustody = {
      context,
      admittedContext,
      authority,
      admissionClosed: false,
      operations: new Map(),
      errors: [],
    };
  }

  /** Select unsupported narrower sources before dispatch, never after a worker failure. */
  function supportsAgentRunWorkerAdmission(authority: AgentRunDelegatedAuthority): boolean {
    const context = access.getState().contexts.get(authority.operationalRunInstance.runId);
    if (context?.delegatedAuthority !== authority || !access.validateAuthority(authority)) {
      throw new Error("Agent run worker admission is no longer active");
    }
    return context.assertSourceCurrent === undefined;
  }

  /** Capture before dispatch; only this exact record can admit its worker transaction. */
  function captureAgentRunWorkerAdmission(
    authority: AgentRunDelegatedAuthority,
  ): AgentRunWorkerTransactionSource {
    const state = access.getState();
    const context = state.contexts.get(authority.operationalRunInstance.runId);
    if (context?.delegatedAuthority !== authority || !access.validateAuthority(authority)) {
      throw new Error("Agent run worker admission is no longer active");
    }
    if (context.assertSourceCurrent) {
      throw new Error("Agent run worker admission requires retained source authority");
    }
    const custody = context.workerCustody;
    if (custody?.authority !== authority) {
      throw new Error("Agent run worker admission has no bound execution owner");
    }
    const assertCurrent = () => {
      if (
        custody.admissionClosed ||
        custody.errors.length > 0 ||
        state.contexts.get(authority.operationalRunInstance.runId) !== context ||
        context.delegatedAuthority !== authority ||
        context.workerCustody !== custody ||
        access.getOwnerStatus(
          authority.operationalRunInstance.runId,
          authority.claimId,
          authority.lifecycleGeneration,
        ) === undefined
      ) {
        throw new Error("Agent run worker admission is no longer active");
      }
    };
    const retain = (operation: RetainedWorkerTransactionAdmission) => {
      if (custody.operations.has(operation)) {
        return;
      }
      const retained = (state.workerCustody ??= new Set());
      retained.add(custody);
      const retainFailure = (error: unknown): never => {
        custody.errors.push(error);
        custody.admissionClosed = true;
        throw error;
      };
      const settled = operation.settled.then((outcome) => {
        if (outcome.kind === "unknown") {
          retainFailure(outcome.error);
        }
        custody.operations.delete(operation);
        if (custody.operations.size === 0 && custody.errors.length === 0) {
          retained.delete(custody);
        }
      }, retainFailure);
      custody.operations.set(operation, settled);
      void settled.catch(() => undefined);
    };
    return {
      assertCurrent,
      admitTransaction(operation, grant) {
        assertCurrent();
        retain(operation);
        grant();
      },
    };
  }

  async function drainAgentRunWorkerCustody(
    matches: (custody: AgentRunWorkerCustody) => boolean,
  ): Promise<void> {
    const state = access.getState();
    while (true) {
      const owners = [...(state.workerCustody ?? [])].filter(matches);
      if (owners.length === 0) {
        return;
      }
      await Promise.allSettled(owners.flatMap((owner) => [...owner.operations.values()]));
      const errors = owners.flatMap((owner) => owner.errors);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Agent run worker cleanup is unresolved");
      }
    }
  }

  /** Join the original instance even after its logical run id has been replaced. */
  function drainAgentRunWorkerTransactions(
    instance: AgentRunDelegatedAuthority["operationalRunInstance"],
  ): Promise<void> {
    return drainAgentRunWorkerCustody(
      (custody) => custody.authority.operationalRunInstance === instance,
    );
  }

  /** Retirement already refused new grants; its lifecycle owner joins the retained work. */
  function drainRetiredAgentRunWorkerTransactions(lifecycleGeneration?: string): Promise<void> {
    return drainAgentRunWorkerCustody(
      (custody) =>
        custody.admissionClosed &&
        (lifecycleGeneration === undefined ||
          custody.authority.lifecycleGeneration === lifecycleGeneration),
    );
  }

  /** Seal this host's exact runs before yielding; sibling host records remain untouched. */
  function retireAndDrainAgentRunWorkerTransactions(
    matches: (
      admittedContext: object,
      instance: AgentRunDelegatedAuthority["operationalRunInstance"],
    ) => boolean,
  ): Promise<void> {
    const state = access.getState();
    const matchesCustody = (custody: AgentRunWorkerCustody) =>
      matches(custody.admittedContext, custody.authority.operationalRunInstance);
    for (const context of state.contexts.values()) {
      if (context.workerCustody && matchesCustody(context.workerCustody)) {
        retireAgentRunWorkerCustody(context);
      }
    }
    for (const custody of state.workerCustody ?? []) {
      if (matchesCustody(custody)) {
        custody.admissionClosed = true;
      }
    }
    return drainAgentRunWorkerCustody(matchesCustody);
  }

  return {
    bind: bindAgentRunWorkerAdmissionOwner,
    supports: supportsAgentRunWorkerAdmission,
    capture: captureAgentRunWorkerAdmission,
    drainInstance: drainAgentRunWorkerTransactions,
    drainRetired: drainRetiredAgentRunWorkerTransactions,
    retireAndDrain: retireAndDrainAgentRunWorkerTransactions,
  };
}
