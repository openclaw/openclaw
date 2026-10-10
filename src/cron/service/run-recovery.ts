import { isDeepStrictEqual } from "node:util";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  exactCronRunReceiptMatches,
  isCronRunReceiptOwnerStale,
} from "../store/run-receipt-store.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import type { CronRunRecoveryResult } from "../store/run-recovery.types.js";
import type { CronJob } from "../types.js";
import { prepareCronFailureAlertPolicies } from "./failure-alerts.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";

class RetiredCronRecoveryError extends Error {
  constructor() {
    super("Cron recovery owner retired");
  }
}

function recoveryAuthority(
  state: CronServiceState,
  context: OpenClawStateWorkerContext,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): () => void {
  const generation = state.lifecycleGeneration;
  return () => {
    context.admission.assertCurrent();
    if (
      state.stopped ||
      state.lifecycleGeneration !== generation ||
      signal?.aborted ||
      isCurrent?.() === false
    ) {
      throw new RetiredCronRecoveryError();
    }
  };
}

async function observeRecoveryProposals(
  state: CronServiceState,
  context: OpenClawStateWorkerContext,
  proposals: readonly CronRunRecoveryProposal[],
  assertCurrent: () => void,
): Promise<{
  proposals: CronRunRecoveryProposal[];
  routing: Array<Pick<CronJob, "id" | "delivery" | "failureAlert">>;
}> {
  if (proposals.length === 0) {
    return { proposals: [], routing: [] };
  }
  const command = {
    type: "cron.observeRunRecovery" as const,
    storeKey: cronStoreKey(state.deps.storePath),
    proposals,
  };
  assertCurrent();
  let result = await executeExistingOpenClawStateRead({}, command);
  assertCurrent();
  if (
    !result ||
    (result.ok &&
      result.type === command.type &&
      result.observation.kind === "schema-uninitialized")
  ) {
    const assertSchemaCurrent = () => {
      context.admission.assertCurrent();
      assertCurrent();
    };
    const { createSqliteWorkerWriteAdmission } = await import("../../infra/sqlite-worker-store.js");
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "cron.initializeRunReceipts", input: {} }),
      {
        assertCurrent: assertSchemaCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertSchemaCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
    assertCurrent();
    result = await executeExistingOpenClawStateRead({}, command);
    assertCurrent();
  }
  if (!result?.ok || result.type !== command.type || result.observation.kind !== "observed") {
    throw new Error("Cron recovery observation did not return its admitted receipt snapshot");
  }
  return {
    proposals: result.observation.proposals.map(({ routing: _routing, ...proposal }) => proposal),
    routing: result.observation.proposals.flatMap(({ routing }) => (routing ? [routing] : [])),
  };
}

function observedRecoveryResult(
  state: CronServiceState,
  proposal: CronRunRecoveryProposal,
  observed: CronRunRecoveryProposal,
): Exclude<CronRunRecoveryResult, { kind: "repaired" }> | undefined {
  const receipt = observed.receipt;
  if (!receipt) {
    return undefined;
  }
  if (!proposal.receipt || !exactCronRunReceiptMatches(receipt, proposal.receipt)) {
    return { kind: "superseded", receipt };
  }
  return isCronRunReceiptOwnerStale(receipt, state.deps.nowMs())
    ? undefined
    : { kind: "live", receipt };
}

async function repairRecoveryProposal(
  state: CronServiceState,
  context: OpenClawStateWorkerContext,
  proposal: CronRunRecoveryProposal,
  mode: "startup" | "reclaim",
  assertOwnerCurrent: () => void,
  publish: (result: CronRunRecoveryResult) => void,
  routing: Pick<CronJob, "id" | "delivery" | "failureAlert"> | undefined,
): Promise<void> {
  const input = {
    storeKey: cronStoreKey(state.deps.storePath),
    proposal: structuredClone(proposal),
    mode,
  };
  let retired = false;
  try {
    await runCronRuntimeMutation({
      context,
      type: "cron.repairRun",
      input,
      assertCurrent() {
        try {
          assertOwnerCurrent();
        } catch (error) {
          retired = error instanceof RetiredCronRecoveryError;
          throw error;
        }
      },
      policy: (() => {
        const alerts = prepareCronFailureAlertPolicies(
          state,
          [proposal.jobId],
          routing ? [routing] : [],
        );
        const receiptIsStale = () =>
          proposal.receipt
            ? isCronRunReceiptOwnerStale(proposal.receipt, state.deps.nowMs())
            : true;
        const cronConfig = structuredClone(state.deps.cronConfig);
        const value = {
          proposedReceiptIsStale: receiptIsStale(),
          failureAlerts: alerts.policies,
          nowMs: state.deps.nowMs(),
          cronConfig,
        };
        return {
          value,
          assertCurrent() {
            alerts.assertCurrent();
            if (
              value.proposedReceiptIsStale !== receiptIsStale() ||
              !isDeepStrictEqual(value.cronConfig, state.deps.cronConfig)
            ) {
              throw new Error("Cron recovery policy or receipt ownership changed before commit");
            }
          },
        };
      })(),
      publish(outcome) {
        if (outcome.result.kind === "repaired") {
          noteCronJobsStoreCommit(input.storeKey);
        }
        publish(outcome.result);
        for (const entry of outcome.logs) {
          state.deps.log[entry.level](entry.fields, entry.message);
        }
      },
    });
  } catch (error) {
    if (retired) {
      throw new RetiredCronRecoveryError();
    }
    throw error;
  }
}

/** Observe the whole batch before any repair; committed candidates publish before a later await fails. */
export async function recoverCronRunProposals(
  state: CronServiceState,
  targets: readonly CronRunRecoveryProposal[],
  options: {
    mode?: "startup" | "reclaim";
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    onRecovery: (proposal: CronRunRecoveryProposal, result: CronRunRecoveryResult) => void;
  },
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = recoveryAuthority(state, context, options.signal, options.isCurrent);
  try {
    const observation = await observeRecoveryProposals(state, context, targets, assertCurrent);
    const observed = observation.proposals;
    const routing = new Map(observation.routing.map((job) => [job.id, job]));
    const repairs: CronRunRecoveryProposal[] = [];
    for (let index = 0; index < observed.length; index += 1) {
      const current = observed[index]!;
      const target = targets[index]!;
      const proposal = target.receipt ? target : current;
      const result = observedRecoveryResult(state, proposal, current);
      if (result) {
        options.onRecovery(proposal, result);
      } else {
        repairs.push(proposal);
      }
    }
    for (const proposal of repairs) {
      assertCurrent();
      await repairRecoveryProposal(
        state,
        context,
        proposal,
        options.mode ?? "reclaim",
        assertCurrent,
        (result) => options.onRecovery(proposal, result),
        routing.get(proposal.jobId),
      );
    }
  } catch (error) {
    if (!(error instanceof RetiredCronRecoveryError)) {
      throw error;
    }
  }
}
