import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentDeleteDatabases } from "../../agents/agent-delete-databases.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { clawCronGatewayJobMatchesRef } from "../../claws/cron.js";
import { digestClawValue } from "../../claws/digest.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import {
  clawMonitorCleanupBindingSchema,
  clawMonitorSnapshotSchema,
} from "../../claws/monitor-cleanup-contract.js";
import {
  readClawMonitorCleanupSnapshot,
  withClawMonitorCleanupSnapshot,
  type ClawMonitorCleanupSnapshot,
} from "../../claws/monitor-cleanup-state.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasActiveCronJobsForAgent } from "../../cron/active-jobs.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { getSuspensionVisibleCronTaskRunCount } from "../../cron/service/active-run-cancellation.js";
import { hasPendingCronSessionCleanupForAgent } from "../../cron/service/locked.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { hasActiveCronRunReceiptsForAgent } from "../../cron/store/run-receipt-drain.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

type ClawMonitorContext = Pick<
  GatewayRequestContext,
  "cron" | "cronStorePath" | "getRuntimeConfig" | "isConfigReloadSettled"
>;

const text = z.string().min(1).max(4096);
const target = { agentId: text, binding: clawMonitorCleanupBindingSchema };
const paramsSchema = z.discriminatedUnion("phase", [
  z.object({ ...target, phase: z.literal("inspect") }).strict(),
  z
    .object({
      phase: z.literal("quiesce"),
      ...target,
      operationId: text,
      monitors: z.array(clawMonitorSnapshotSchema).max(2),
    })
    .strict(),
  z.object({ ...target, phase: z.literal("drain"), operationId: text }).strict(),
]);

function assertDeletionFence(
  agentId: string,
  operationId: string,
  config: OpenClawConfig,
  snapshot: ClawMonitorCleanupSnapshot | undefined,
): asserts snapshot is ClawMonitorCleanupSnapshot & {
  journal: NonNullable<ClawMonitorCleanupSnapshot["journal"]>;
} {
  const journal = snapshot?.journal;
  const install = snapshot?.install;
  if (!journal || journal.operationId !== operationId || journal.cleanupCompleted) {
    throw new Error("Claw removal no longer owns the serving Gateway's deletion fence.");
  }
  // Orphaned ownership can outlive its install row, but must never remove a configured replacement.
  const agent = listAgentEntries(config).find((entry) => entry.id === agentId);
  if (agent && digestClawValue(agent) !== install?.agentConfigDigest) {
    throw new Error("The serving Gateway's Claw agent configuration changed after planning.");
  }
}

function isLocallyDrained(
  context: ClawMonitorContext,
  agentId: string,
  requireConfigRemoval: boolean,
  snapshot: ClawMonitorCleanupSnapshot,
) {
  return (
    (!requireConfigRemoval ||
      (context.isConfigReloadSettled() &&
        !listAgentEntries(context.getRuntimeConfig()).some((agent) => agent.id === agentId))) &&
    !hasActiveCronJobsForAgent(agentId) &&
    getSuspensionVisibleCronTaskRunCount({ agentId }) === 0 &&
    !hasPendingCronSessionCleanupForAgent(agentId) &&
    (!requireConfigRemoval || snapshot.attached.length === 0)
  );
}

async function waitForDrain(
  context: ClawMonitorContext,
  agentId: string,
  requireConfigRemoval: boolean,
  assertCurrent: () => Promise<ClawMonitorCleanupSnapshot>,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  do {
    let snapshot = await assertCurrent();
    if (isLocallyDrained(context, agentId, requireConfigRemoval, snapshot)) {
      const activeReceipts = await hasActiveCronRunReceiptsForAgent(agentId);
      snapshot = await assertCurrent();
      if (!activeReceipts && isLocallyDrained(context, agentId, requireConfigRemoval, snapshot)) {
        return;
      }
    }
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error(
    "Gateway monitor cancellation, run drainage, or config convergence is incomplete; preview and retry Claw removal.",
  );
}

export const clawsMonitorHandlers = {
  "claws.monitors": async ({
    params,
    respond,
    context,
  }: {
    params: Record<string, unknown>;
    respond: RespondFn;
    context: ClawMonitorContext;
  }) => {
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw monitor cleanup parameters."),
      );
      return;
    }
    const input = parsed.data;
    try {
      const cron = context.cron;
      const assertBinding = () => {
        if (
          !isDeepStrictEqual(input.binding, resolveClawMonitorCleanupBinding(context.cronStorePath))
        ) {
          throw new Error("Gateway does not serve this Claw's config and scheduler state.");
        }
        if (
          input.phase !== "drain" &&
          (context.cron !== cron || !context.isConfigReloadSettled())
        ) {
          throw new Error("Gateway scheduler or configuration is changing; retry Claw removal.");
        }
      };
      assertBinding();
      const readSnapshot = () =>
        readClawMonitorCleanupSnapshot({
          agentId: input.agentId,
          storePath: context.cronStorePath,
          defaultAgentId: tryResolveAmbientOwnerAgentId(context.getRuntimeConfig()),
        });
      const captureSource = () => {
        const cfg = context.getRuntimeConfig();
        const source = getRuntimeConfigSourceSnapshot();
        const configDigest = digestClawValue(cfg);
        const sourceDigest = digestClawValue(source);
        return {
          cfg,
          assertCurrent: () => {
            assertBinding();
            if (
              context.getRuntimeConfig() !== cfg ||
              getRuntimeConfigSourceSnapshot() !== source ||
              digestClawValue(cfg) !== configDigest ||
              digestClawValue(source) !== sourceDigest
            ) {
              throw new Error("Gateway configuration changed before monitor cancellation.");
            }
          },
        };
      };
      if (input.phase === "inspect") {
        respond(true, { monitors: [] }, undefined);
        return;
      }
      const assertCurrent = async () => {
        const snapshot = await readSnapshot();
        assertBinding();
        assertDeletionFence(input.agentId, input.operationId, context.getRuntimeConfig(), snapshot);
        return snapshot;
      };
      await assertCurrent();
      if (input.phase === "quiesce") {
        const source = captureSource();
        const jobs = await cron.list({ includeDisabled: true });
        source.assertCurrent();
        const snapshot = await assertCurrent();
        source.assertCurrent();
        if (input.monitors.length !== 0) {
          throw new Error("Config-owned monitors changed after removal planning.");
        }
        const { refs, attached, portable } = snapshot;
        const allowed = attached.map((row) => {
          const job = jobs.find((candidate) => candidate.id === row.id);
          if (
            !job ||
            !row.revision ||
            row.storeKey !== cronStoreKey(context.cronStorePath) ||
            resolveCronJobConfigRevision(job) !== row.revision ||
            (!refs.some(
              (ref) =>
                ref.status === "complete" &&
                ref.schedulerJobId === row.id &&
                clawCronGatewayJobMatchesRef(input.agentId, ref, cronJobReadView(job)),
            ) &&
              !(portable.owned && portable.jobId === row.id))
          ) {
            throw new Error(
              `Independent or changed cron job ${row.id} still references the Claw agent.`,
            );
          }
          return { id: row.id, revision: row.revision };
        });
        await cron.quiesceJobs(allowed, source.assertCurrent, (cancel) =>
          withClawMonitorCleanupSnapshot(
            {
              agentId: input.agentId,
              storePath: context.cronStorePath,
              defaultAgentId: tryResolveAmbientOwnerAgentId(source.cfg),
            },
            snapshot,
            source.assertCurrent,
            cancel,
          ),
        );
      }
      await waitForDrain(context, input.agentId, input.phase === "drain", assertCurrent);
      let snapshot = await assertCurrent();
      if (!isLocallyDrained(context, input.agentId, input.phase === "drain", snapshot)) {
        throw new Error(
          "Gateway cleanup state changed before database preparation; retry Claw removal.",
        );
      }
      if (input.phase === "quiesce") {
        await prepareAgentDeleteDatabases(
          context.getRuntimeConfig(),
          input.agentId,
          snapshot.journal.agentDir,
        );
        await assertCurrent();
      }
      const activeReceipts = await hasActiveCronRunReceiptsForAgent(input.agentId);
      snapshot = await assertCurrent();
      if (
        activeReceipts ||
        !isLocallyDrained(context, input.agentId, input.phase === "drain", snapshot)
      ) {
        throw new Error(
          "Gateway cleanup state changed before drainage was acknowledged; retry Claw removal.",
        );
      }
      respond(true, { drained: true }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
      );
    }
  },
} satisfies GatewayRequestHandlers;
