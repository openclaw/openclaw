import { analyzeLegacyHeartbeatTasks } from "../commands/heartbeat-task-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { hashCronScratchSource } from "../cron/scratch-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { clawAutomationInstallIntent } from "./automation-install-intent.js";
import type { ClawCronUpdateExecution } from "./cron-update-contract.js";
import { CLAW_PORTABLE_HEARTBEAT_ID, type ClawCronGateway } from "./cron.js";
import { digestClawValue as digest } from "./digest.js";
import { mutatePortableHeartbeatViaGateway } from "./portable-heartbeat-gateway.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import {
  portableHeartbeatDrift,
  portableHeartbeatStateDigest,
} from "./portable-heartbeat-state.kernel.js";
import { mutatePortableHeartbeat } from "./portable-heartbeat-write.js";
import {
  exportPortableHeartbeat,
  portableHeartbeatJob,
  portableHeartbeatSettingsRevision,
  portableHeartbeatSourceFromState,
  publishPortableHeartbeat,
  readPortableHeartbeatSource,
} from "./portable-heartbeat.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

function sourceDigest(
  source: Awaited<ReturnType<typeof readPortableHeartbeatSource>>,
): string | undefined {
  return source
    ? digest({
        heartbeat: source.heartbeat,
        scratchDigest:
          source.scratch === undefined ? undefined : hashCronScratchSource(source.scratch),
      })
    : undefined;
}
export async function planPortableHeartbeatUpdate(
  target: ClawAddPlan,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
): Promise<ClawUpdateAction | undefined> {
  const source = await readPortableHeartbeatSource(target);
  const current = await readPortableHeartbeatState(target.agent.finalId, cfg, options);
  if (!source && (!current.ref || current.ref.status === "removed")) {
    return undefined;
  }
  const desiredDigest = sourceDigest(source);
  const sameDeclaration =
    current.ref &&
    digest({
      heartbeat: current.ref.job.heartbeat,
      scratchDigest: current.ref.job.scratchDigest,
    }) === desiredDigest;
  const hasTasks =
    source?.scratch !== undefined && analyzeLegacyHeartbeatTasks(source.scratch).hasTasksBlock;
  let unrepresentable: string | undefined;
  if (current.ref && source) {
    try {
      await exportPortableHeartbeat(target.agent.finalId, cfg, options);
    } catch (error) {
      unrepresentable = error instanceof Error ? error.message : String(error);
    }
  }
  const blocked =
    Boolean(unrepresentable) ||
    (current.ref ? portableHeartbeatDrift(current) : Boolean(current.receipt)) ||
    hasTasks ||
    Boolean(current.receipt?.convertedJobIds?.length);
  const action = blocked
    ? "manual"
    : !current.ref
      ? "add"
      : !source
        ? "release"
        : sameDeclaration
          ? "unchanged"
          : "change";
  return {
    kind: "cronJob",
    id: CLAW_PORTABLE_HEARTBEAT_ID,
    action,
    target: current.receipt?.jobId ?? `automation:${target.agent.finalId}`,
    blocked,
    currentDigest: portableHeartbeatStateDigest(current),
    ...(desiredDigest ? { desiredDigest } : {}),
    reason:
      unrepresentable ??
      (blocked
        ? "Receipt-owned automation or scratch was edited, deleted, or has unresolved ownership; preserve it and reconcile explicitly."
        : action === "release"
          ? "Release the portable artifact reference while retaining the ordinary automation, scratch, and history. Remove the job explicitly if no longer wanted."
          : "Import portable settings into the same ordinary automation; retain identity, history and scratch CAS."),
  };
}

export async function applyPortableHeartbeatUpdate(
  update: ClawUpdatePlan,
  target: ClawAddPlan,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions & { cronGateway?: ClawCronGateway },
): Promise<ClawCronUpdateExecution> {
  const action = update.actions.find(
    (item) => item.id === CLAW_PORTABLE_HEARTBEAT_ID && item.kind === "cronJob",
  );
  if (!action || action.action === "unchanged") {
    return { appliedIds: [], rollback: async () => {} };
  }
  const source = await readPortableHeartbeatSource(target);
  if (sourceDigest(source) !== action.desiredDigest) {
    throw new Error("Portable source changed after consent; rebuild the Claw update plan.");
  }
  const before = await readPortableHeartbeatState(update.agentId, cfg, options);
  if (action.currentDigest !== portableHeartbeatStateDigest(before) || action.blocked) {
    throw new Error("Portable automation changed after consent; rebuild the Claw update plan.");
  }
  const publish = () => publishPortableHeartbeat(update.agentId, cfg, options);
  const common = { agentId: update.agentId, storePath: before.storePath };
  if (action.action === "add" && source && !before.ref && !before.receipt) {
    return {
      appliedIds: [CLAW_PORTABLE_HEARTBEAT_ID],
      publish,
      rollback: async () => {},
      commit: async (install) => {
        if (options.cronGateway) {
          const outcome = await mutatePortableHeartbeatViaGateway(
            update.agentId,
            cfg,
            before,
            {
              kind: "import",
              source,
              expectedSettingsRevision: portableHeartbeatSettingsRevision(
                cfg,
                update.agentId,
                source.heartbeat,
              ),
              install: clawAutomationInstallIntent(install),
            },
            { ...options, cronGateway: options.cronGateway },
          );
          if (!outcome.installRecord) {
            throw new Error("Portable automation commit did not return its install provenance.");
          }
          return outcome.installRecord;
        }
        const nowMs = Date.now();
        const outcome = await mutatePortableHeartbeat(
          {
            ...common,
            kind: "import",
            nowMs,
            expected: before,
            plannedJob: portableHeartbeatJob(cfg, update.agentId, source.heartbeat, nowMs),
            source,
            install,
          },
          options,
        );
        if (!outcome.installRecord) {
          throw new Error("Portable automation commit did not return its install provenance.");
        }
        return outcome.installRecord;
      },
    };
  }
  if (!before.ref || !before.job || !before.receipt) {
    throw new Error("Portable ownership is missing; no job was provisioned.");
  }
  if (options.cronGateway) {
    const gatewayOptions = { ...options, cronGateway: options.cronGateway };
    const previousSource = portableHeartbeatSourceFromState(update.agentId, cfg, before);
    if (!previousSource) {
      throw new Error("Portable automation rollback has no original authored settings.");
    }
    const { state: after } = await mutatePortableHeartbeatViaGateway(
      update.agentId,
      cfg,
      before,
      source
        ? {
            kind: "update",
            source,
            expectedSettingsRevision: portableHeartbeatSettingsRevision(
              cfg,
              update.agentId,
              source.heartbeat,
            ),
          }
        : { kind: "release" },
      gatewayOptions,
    );
    const previous = {
      source: previousSource,
      configRevision: resolveCronJobConfigRevision(before.job),
      heartbeat: before.ref.job.heartbeat,
      sourceScratchDigest: before.ref.job.sourceScratchDigest,
      sourceAgentDigest: before.ref.job.sourceAgentDigest,
      expectedRuntimeDigest: digest(after.job?.state),
      nextRunAtMs: before.job.state.nextRunAtMs,
    };
    return {
      appliedIds: [CLAW_PORTABLE_HEARTBEAT_ID],
      publish,
      rollback: async () => {
        await mutatePortableHeartbeatViaGateway(
          update.agentId,
          cfg,
          after,
          { kind: "rollback", previous },
          gatewayOptions,
        );
        await publish();
      },
    };
  }
  const nowMs = Date.now();
  const after = (
    await mutatePortableHeartbeat(
      source
        ? {
            ...common,
            kind: "update",
            nowMs,
            expected: before,
            plannedJob: portableHeartbeatJob(
              cfg,
              update.agentId,
              source.heartbeat,
              before.job.createdAtMs,
            ),
            source,
          }
        : { ...common, kind: "release", nowMs, expected: before },
      options,
    )
  ).state;
  return {
    appliedIds: [CLAW_PORTABLE_HEARTBEAT_ID],
    publish,
    rollback: async () => {
      await mutatePortableHeartbeat(
        { ...common, kind: "rollback", nowMs: Date.now(), expected: after, previous: before },
        options,
      );
      await publish();
    },
  };
}
