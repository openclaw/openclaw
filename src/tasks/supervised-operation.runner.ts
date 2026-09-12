import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { getSupervisedCommandResources } from "./supervised-command-custody.js";
import { observeSupervisedOperationProcess } from "./supervised-operation.capacity.js";
import {
  assertSupervisedOperationCurrent,
  bindSupervisedOperationProcess,
  getSupervisedOperationExecution,
  getSupervisedOperation,
  heartbeatSupervisedOperation,
  recordSupervisedOperationOutcome,
  reserveSupervisedOperationDispatch,
  releaseSupervisedOperationForReconciliation,
} from "./supervised-operation.store.js";
import type { SupervisedOperationOutcome } from "./supervised-operation.types.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";
import { authorizeSupervisedWorkflowRequest } from "./supervised-workflow.types.js";
import {
  releaseSupervisedWorkspaceOwner,
  retireSupervisedWorkspaces,
} from "./supervised-workspace-retention.js";
import {
  prepareSupervisedOperationWorkspace,
  acceptSupervisedOperationWorkspace,
} from "./supervised-workspace-versions.js";

/** Runs in its own process: coordinator lifetime is deliberately not its owner. */
export async function runSupervisedOperationProcess(
  operationId: string,
  executionId: string,
  options: SupervisedWorkflowDatabaseOptions = {},
): Promise<void> {
  const operation = getSupervisedOperation(operationId, options);
  const execution = getSupervisedOperationExecution(executionId, options);
  if (
    !operation ||
    !execution ||
    execution.operationId !== operationId ||
    operation.executionId !== executionId
  ) {
    return;
  }
  const identity = requireNodeWorkerProcessIdentity(process.pid);
  observeSupervisedOperationProcess(executionId, identity, Date.now(), options);
  bindSupervisedOperationProcess(execution, identity, Date.now(), options);
  const controller = new AbortController();
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    assertSupervisedOperationCurrent(execution, Date.now(), options);
  };
  const reserveDispatch = () => reserveSupervisedOperationDispatch(execution, Date.now(), options);
  const heartbeat = setInterval(() => {
    try {
      heartbeatSupervisedOperation(execution, Date.now(), options);
    } catch (error) {
      controller.abort(error);
    }
  }, 1000);
  const stop = () => controller.abort(new Error("Independent operation runner stopping"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const encoded = getSupervisedWorkflowContract(operation.flowId, operation.episode, options);
    if (!encoded || encoded.hash !== operation.contractHash) {
      throw new Error("Operation lost its accepted contract");
    }
    const { profile } = authorizeSupervisedWorkflowRequest(encoded.contract, operation.request);
    // The launch reservation covers bounded bootstrap. Begin heartbeats before
    // importing cold adapters; failed preparation consumes this execution budget.
    const publication =
      profile.kind === "publication"
        ? await import("./supervised-operation.publication.js")
        : undefined;
    const ci = profile.kind === "ci" ? await import("./supervised-operation.ci.js") : undefined;
    assertCurrent();
    let outcome: SupervisedOperationOutcome;
    let outcomeRecorded = false;
    const workspace = await prepareSupervisedOperationWorkspace(
      execution,
      encoded.contract,
      options,
      false,
      assertCurrent,
    );
    const context = {
      contract: workspace.contract,
      signal: controller.signal,
      assertCurrent,
      reserveDispatch,
    };
    if (profile.kind === "command") {
      const { runSupervisedCommand } = await import("./supervised-operation.command.js");
      assertCurrent();
      const completed = await runSupervisedCommand({
        signal: controller.signal,
        assertCurrent,
        execution,
        options,
      });
      outcome = completed.outcome;
      if (!controller.signal.aborted) {
        if (!profile.writable && outcome.facts.sourceHash !== outcome.facts.resultHash) {
          throw new Error("Read-only command changed its accepted source");
        }
        await acceptSupervisedOperationWorkspace(
          execution,
          {
            ...workspace,
            contract: { ...workspace.contract, workspace: completed.workspace },
          },
          options,
          assertCurrent,
          outcome,
        );
        outcomeRecorded = true;
      }
    } else if (profile.kind === "review") {
      const { runScopedSupervisedReview } = await import("./supervised-review-runner.js");
      assertCurrent();
      outcome = await runScopedSupervisedReview({
        execution,
        options,
        signal: controller.signal,
        assertCurrent,
      });
    } else if (profile.kind === "publication" && publication) {
      outcome = await publication.runSupervisedPublication({
        ...context,
        profile,
        execution,
        options,
      });
    } else if (profile.kind === "ci" && ci) {
      outcome = await ci.runSupervisedCI({
        ...context,
        profile,
        execution,
        options,
        flowId: operation.flowId,
        episode: operation.episode,
        deadlineAt: operation.deadlineAt,
      });
    } else {
      throw new Error("Accepted operation adapter unavailable");
    }
    if (!outcomeRecorded) {
      recordSupervisedOperationOutcome(execution, outcome, Date.now(), options);
    }
    // Command outcomes include required process-tree extinction; thrown paths
    // retain reservations until the independent runner is observed gone.
    releaseSupervisedWorkspaceOwner("operation", executionId, Date.now(), options);
  } catch (error) {
    const current = getSupervisedOperationExecution(executionId, options);
    const resources = getSupervisedCommandResources(executionId, options);
    if (
      operation.request.kind === "review" &&
      ((resources && resources.state !== "closed") ||
        (current?.dispatchedAt !== null && current?.dispatchedAt !== undefined && !resources))
    ) {
      // No final review receipt before full runtime extinction. Stop renewing;
      // the dispatcher reconciles exact custody after this runner exits.
      throw new Error("Review runtime closure remains unresolved", { cause: error });
    }
    if (
      (current?.dispatchedAt === null && (!resources || resources.state === "closed")) ||
      operation.request.kind === "publication" ||
      operation.request.kind === "ci"
    ) {
      // A runner stop is not cancellation of its external effect. This write
      // still checks task/lease authority; a revoked owner cannot reopen work.
      releaseSupervisedOperationForReconciliation(
        execution,
        Date.now(),
        options,
        error instanceof Error ? error.message : "Independent operation preparation failed",
      );
      return;
    }
    // Never turn a thrown transport error into proof that a dispatched effect
    // did not happen. The independent receipt preserves uncertainty explicitly.
    const summary =
      error instanceof Error && error.message.length <= 2048
        ? error.message
        : "Operation failed; oversized diagnostic omitted";
    recordSupervisedOperationOutcome(
      execution,
      {
        status: controller.signal.aborted ? "cancelled" : "input_required",
        summary,
        facts: {},
        artifacts: [],
      },
      Date.now(),
      options,
    );
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  // Cleanup failure exits the runner but cannot replace its persisted outcome.
  await retireSupervisedWorkspaces(Date.now(), options);
}
