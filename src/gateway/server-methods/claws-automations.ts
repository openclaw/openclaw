import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentEntries } from "../../agents/agent-scope-config.js";
import {
  clawAutomationMutationRequestSchema,
  type ClawAutomationMutationRequest,
} from "../../claws/automation-mutation-contract.js";
import { digestClawValue } from "../../claws/digest.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import { readPortableHeartbeatState } from "../../claws/portable-heartbeat-state.js";
import {
  portableHeartbeatDrift,
  portableHeartbeatStateDigest,
} from "../../claws/portable-heartbeat-state.kernel.js";
import type { PortableHeartbeatState } from "../../claws/portable-heartbeat-state.types.js";
import {
  ClawPortableMutationUncertainError,
  mutatePortableHeartbeat,
} from "../../claws/portable-heartbeat-write.js";
import type { PortableHeartbeatMutation } from "../../claws/portable-heartbeat-write.types.js";
import {
  portableHeartbeatJob,
  portableHeartbeatSettingsRevision,
  portableHeartbeatSourceFromState,
} from "../../claws/portable-heartbeat.js";
import { analyzeLegacyHeartbeatTasks } from "../../commands/heartbeat-task-legacy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { hashCronScratchSource } from "../../cron/scratch-store.js";
import { computeJobNextRunAtMs } from "../../cron/service/jobs-scheduling.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

function reconstructRollback(
  input: Extract<ClawAutomationMutationRequest["mutation"], { kind: "rollback" }>,
  agentId: string,
  cfg: OpenClawConfig,
  current: PortableHeartbeatState,
  nowMs: number,
): PortableHeartbeatState {
  if (!current.job || !current.ref) {
    throw new Error("Portable automation rollback lost its original ownership.");
  }
  const previous = input.previous;
  const planned = portableHeartbeatJob(
    cfg,
    agentId,
    previous.source.heartbeat,
    current.job.createdAtMs,
  );
  const job = {
    ...current.job,
    enabled: planned.enabled,
    schedule: planned.schedule,
    activeHours: planned.activeHours,
    sessionTarget: planned.sessionTarget,
    sessionKey: planned.sessionKey,
    payload: planned.payload,
  };
  if (job.schedule.kind === "every" && current.job.schedule.kind === "every") {
    job.schedule.anchorMs = current.job.schedule.anchorMs;
  }
  if (resolveCronJobConfigRevision(job) !== previous.configRevision) {
    throw new Error("Portable rollback cannot reconstruct the previous authored configuration.");
  }
  job.state = {
    ...current.job.state,
    nextRunAtMs:
      digestClawValue(current.job.state) === previous.expectedRuntimeDigest
        ? previous.nextRunAtMs
        : computeJobNextRunAtMs(job, nowMs),
  };
  return {
    ...current,
    job,
    ref: {
      ...current.ref,
      status: "complete",
      updatedAtMs: nowMs,
      job: {
        heartbeat: previous.heartbeat,
        configRevision: previous.configRevision,
        ...(previous.source.scratch === undefined
          ? {}
          : { scratchDigest: hashCronScratchSource(previous.source.scratch) }),
        ...(previous.sourceScratchDigest
          ? { sourceScratchDigest: previous.sourceScratchDigest }
          : {}),
        ...(previous.sourceAgentDigest ? { sourceAgentDigest: previous.sourceAgentDigest } : {}),
      },
    },
    scratch: {
      currentRevision: current.scratch.currentRevision,
      ...(previous.source.scratch === undefined
        ? {}
        : {
            scratch: {
              content: previous.source.scratch,
              revision: current.scratch.currentRevision,
              updatedAtMs: nowMs,
            },
          }),
    },
  };
}

type AutomationMutationOptions = Pick<
  GatewayRequestHandlerOptions,
  "params" | "respond" | "signal" | "sessionMutationCommitGuard" | "hasCurrentClientAuthority"
> & {
  context: Pick<
    GatewayRequestContext,
    "cronStorePath" | "getRuntimeConfig" | "isConfigReloadSettled"
  > & { cron: Pick<GatewayRequestContext["cron"], "remove"> };
};

export const clawsAutomationHandlers = {
  "claws.automations.mutate": async ({
    params,
    respond,
    context,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }: AutomationMutationOptions) => {
    const parsed = clawAutomationMutationRequestSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw automation mutation."),
      );
      return;
    }
    const input = parsed.data;
    let removalDispatched = false;
    try {
      const cfg = structuredClone(context.getRuntimeConfig());
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
        if (
          hasCurrentClientAuthority?.() === false ||
          !context.isConfigReloadSettled() ||
          !isDeepStrictEqual(
            input.binding,
            resolveClawMonitorCleanupBinding(context.cronStorePath),
          ) ||
          !isDeepStrictEqual(cfg, context.getRuntimeConfig()) ||
          !listAgentEntries(cfg).some((agent) => agent.id === input.agentId)
        ) {
          throw new Error(
            "Claw automation mutation no longer owns the selected Gateway configuration.",
          );
        }
      };
      assertCurrent();
      const current = await readPortableHeartbeatState(input.agentId, cfg, {});
      assertCurrent();
      if (
        current.storePath !== context.cronStorePath ||
        portableHeartbeatStateDigest(current) !== input.expectedStateDigest
      ) {
        throw new Error("Portable automation changed after planning; rebuild the Claw plan.");
      }
      const intent = input.mutation;
      if (intent.kind === "remove") {
        if (current.job?.id !== intent.jobId || portableHeartbeatDrift(current)) {
          throw new Error("Portable automation changed before removal; rebuild the Claw plan.");
        }
        removalDispatched = true;
        await context.cron.remove(intent.jobId, {
          commitGuard: assertCurrent,
          clawPrecondition: {
            agentId: input.agentId,
            jobId: intent.jobId,
            configRevision: resolveCronJobConfigRevision(current.job),
            expectedStateDigest: input.expectedStateDigest,
            expectedInstallDigest: intent.expectedInstallDigest,
            deletion: intent.deletion,
          },
        });
        const after = await readPortableHeartbeatState(input.agentId, cfg, {});
        assertCurrent();
        respond(true, { stateDigest: portableHeartbeatStateDigest(after) }, undefined);
        return;
      }
      if (
        (intent.kind === "import" || intent.kind === "update") &&
        intent.expectedSettingsRevision !==
          portableHeartbeatSettingsRevision(cfg, input.agentId, intent.source.heartbeat)
      ) {
        throw new Error(
          "Portable automation settings changed after planning; rebuild the Claw plan.",
        );
      }
      const common = {
        agentId: input.agentId,
        storePath: current.storePath,
        nowMs: Date.now(),
        expected: current,
      };
      let mutation: PortableHeartbeatMutation;
      if (intent.kind === "import") {
        mutation = {
          ...common,
          kind: "import",
          source: intent.source,
          plannedJob: portableHeartbeatJob(
            cfg,
            input.agentId,
            intent.source.heartbeat,
            common.nowMs,
          ),
          ...(intent.install ? { gatewayInstall: { intent: intent.install, config: cfg } } : {}),
        };
      } else if (intent.kind === "completeTasks") {
        mutation = { ...common, ...intent };
      } else {
        // Rollback may restore a released artifact, but cannot adopt operator edits or grants.
        const owned =
          intent.kind === "rollback" && current.ref?.status === "removed"
            ? { ...current, ref: { ...current.ref, status: "complete" as const } }
            : current;
        if (!current.job || portableHeartbeatDrift(owned)) {
          throw new Error(
            "Portable ownership changed; reconcile the ordinary automation explicitly.",
          );
        }
        portableHeartbeatSourceFromState(input.agentId, cfg, current);
        if (intent.kind === "update") {
          if (
            intent.source.scratch !== undefined &&
            analyzeLegacyHeartbeatTasks(intent.source.scratch).hasTasksBlock
          ) {
            throw new Error("Structured heartbeat tasks require a new portable import.");
          }
          mutation = {
            ...common,
            kind: "update",
            source: intent.source,
            plannedJob: portableHeartbeatJob(
              cfg,
              input.agentId,
              intent.source.heartbeat,
              current.job.createdAtMs,
            ),
          };
        } else if (intent.kind === "release") {
          mutation = { ...common, kind: "release" };
        } else {
          mutation = {
            ...common,
            kind: "rollback",
            previous: reconstructRollback(intent, input.agentId, cfg, current, common.nowMs),
          };
        }
      }
      const result = await mutatePortableHeartbeat(mutation, { assertCurrent });
      respond(
        true,
        {
          stateDigest: portableHeartbeatStateDigest(result.state),
          ...(result.installRecord ? { installDigest: digestClawValue(result.installRecord) } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, String(error), {
          details: {
            outcomeUnknown:
              removalDispatched || error instanceof ClawPortableMutationUncertainError,
          },
        }),
      );
    }
  },
} satisfies GatewayRequestHandlers;
