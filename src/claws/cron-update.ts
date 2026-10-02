import { coerceErrorMessage } from "@openclaw/normalization-core";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayJobMatchesRef,
  clawCronGatewayInput,
  clawCronSchedulerJobFromResult,
  deleteClawCronRef,
  readClawCronRefs,
  upsertClawCronRef,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import { digestClawValue as digest } from "./digest.js";
import type { ClawCronJob, ClawManifest } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import { collectClawRollbackFailures } from "./update-rollback.js";
import {
  deleteClawCronRefForUpdate,
  readClawCronRefsForUpdate,
  upsertClawCronRefForUpdate,
  type ClawUpdateStateOptions,
} from "./update-state-write.js";

export type ClawCronUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
};

export class ClawCronUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawCronUpdateError";
  }
}

function targetRef(params: {
  agentId: string;
  job: ClawCronJob;
  previous?: PersistedClawCronRef;
  nowMs: number;
}): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: params.agentId,
    manifestId: params.job.id,
    declarationKey: `claw:${params.agentId}:${params.job.id}`,
    status: "pending",
    job: params.job,
    createdAtMs: params.previous?.createdAtMs ?? params.nowMs,
    updatedAtMs: params.nowMs,
  };
}

export async function applyClawCronUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  options: ClawUpdateStateOptions & {
    cronGateway?: ClawCronGateway;
    nowMs?: number;
    readRefs?: typeof readClawCronRefs | typeof readClawCronRefsForUpdate;
    upsertRef?: typeof upsertClawCronRef | typeof upsertClawCronRefForUpdate;
    deleteRef?: typeof deleteClawCronRef | typeof deleteClawCronRefForUpdate;
  },
): Promise<ClawCronUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "cronJob" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedIds: [], rollback: async () => undefined };
  }
  if (!options.cronGateway) {
    throw new ClawCronUpdateError("Claw cron updates require the gateway cron API.");
  }
  if (!options.cronGateway.get) {
    throw new ClawCronUpdateError("Claw cron updates require the gateway cron.get API.");
  }
  const gateway = options.cronGateway;
  const readRefs = options.readRefs ?? readClawCronRefsForUpdate;
  const upsertRef = options.upsertRef ?? upsertClawCronRefForUpdate;
  const deleteRef = options.deleteRef ?? deleteClawCronRefForUpdate;
  const currentRefs = new Map(
    (await readRefs(updatePlan.agentId, options)).map((ref) => [ref.manifestId, ref]),
  );
  const targetJobs = new Map(targetManifest.cronJobs.map((job) => [job.id, job]));
  const undo: Array<() => Promise<void>> = [];
  const appliedIds: string[] = [];
  const nowMs = options.nowMs ?? Date.now();
  let agentAvailable = false;

  const waitForAgent = async () => {
    if (!agentAvailable) {
      await gateway.waitUntilAgentAvailable?.(updatePlan.agentId);
      options.assertCurrent?.();
      agentAvailable = true;
    }
  };
  const add = async (ref: PersistedClawCronRef): Promise<string> => {
    await waitForAgent();
    let raw: unknown;
    try {
      options.assertCurrent?.();
      raw = await gateway.add(clawCronGatewayInput(updatePlan.agentId, ref));
      options.assertCurrent?.();
    } catch (error) {
      throw new ClawCronUpdateError(coerceErrorMessage(error), true);
    }
    const result = clawCronSchedulerJobFromResult(raw);
    if (!result) {
      throw new ClawCronUpdateError("cron.add returned no scheduler job id.", true);
    }
    return result.id;
  };
  const rollback = async () => {
    const failures = await collectClawRollbackFailures(undo.toReversed());
    if (failures.length > 0) {
      throw new ClawCronUpdateError(failures.join("; "));
    }
  };

  try {
    for (const action of actions) {
      const previous = currentRefs.get(action.id);
      if (previous && action.currentDigest && digest(previous.job) !== action.currentDigest) {
        throw new ClawCronUpdateError(
          `Cron declaration ${JSON.stringify(action.id)} changed after planning.`,
        );
      }
      if (previous?.schedulerJobId) {
        const live = await gateway.get!(previous.schedulerJobId);
        options.assertCurrent?.();
        if (!clawCronGatewayJobMatchesRef(updatePlan.agentId, previous, live)) {
          throw new ClawCronUpdateError(
            `Cron declaration ${JSON.stringify(action.id)} changed after planning.`,
          );
        }
      }
      if (action.action === "remove") {
        if (!previous?.schedulerJobId || previous.status !== "complete") {
          throw new ClawCronUpdateError(
            `Cron declaration ${JSON.stringify(action.id)} is no longer safely removable.`,
          );
        }
        await upsertRef({ ...previous, status: "pending", updatedAtMs: nowMs }, options);
        try {
          options.assertCurrent?.();
          await gateway.remove(previous.schedulerJobId);
          options.assertCurrent?.();
        } catch (error) {
          throw new ClawCronUpdateError(coerceErrorMessage(error), true);
        }
        undo.push(async () => {
          const restoredId = await add(previous);
          await upsertRef({ ...previous, schedulerJobId: restoredId, updatedAtMs: nowMs }, options);
        });
        await deleteRef(updatePlan.agentId, action.id, options);
        appliedIds.push(action.id);
        continue;
      }

      const job = targetJobs.get(action.id);
      if (!job) {
        throw new ClawCronUpdateError(
          `Target cron declaration ${JSON.stringify(action.id)} is missing.`,
        );
      }
      // A readiness failure must leave this declaration's ownership untouched.
      await waitForAgent();
      const pending = targetRef({ agentId: updatePlan.agentId, job, previous, nowMs });
      await upsertRef(pending, options);
      const schedulerJobId = await add(pending);
      if (action.action === "change") {
        if (!previous?.schedulerJobId || schedulerJobId !== previous.schedulerJobId) {
          try {
            options.assertCurrent?.();
            await gateway.remove(schedulerJobId);
            options.assertCurrent?.();
            if (previous) {
              await upsertRef(previous, options);
            }
          } catch (error) {
            throw new ClawCronUpdateError(
              `cron.add did not converge and cleanup failed: ${coerceErrorMessage(error)}`,
              true,
            );
          }
          throw new ClawCronUpdateError(
            `cron.add did not converge declaration ${JSON.stringify(action.id)} on its owned scheduler job.`,
          );
        }
        undo.push(async () => {
          const restoredId = await add(previous);
          await upsertRef({ ...previous, schedulerJobId: restoredId, updatedAtMs: nowMs }, options);
        });
      } else {
        undo.push(async () => {
          options.assertCurrent?.();
          await gateway.remove(schedulerJobId);
          options.assertCurrent?.();
          await deleteRef(updatePlan.agentId, action.id, options);
        });
      }
      await upsertRef({ ...pending, schedulerJobId, status: "complete" }, options);
      appliedIds.push(action.id);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawCronUpdateError(
        `${coerceErrorMessage(error)}; rollback failed: ${coerceErrorMessage(rollbackError)}`,
        true,
      );
    }
    throw new ClawCronUpdateError(
      coerceErrorMessage(error),
      error instanceof ClawCronUpdateError && error.partial,
    );
  }
  return { appliedIds, rollback };
}
