/** Deprecated artifact adapter. Ordinary job/scratch rows are the only runtime owners. */
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { CronJobSchema } from "../../packages/gateway-protocol/src/schema/cron.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { maybeMigrateHeartbeatTasksToCron } from "../commands/doctor-heartbeat-task-migration.js";
import { analyzeLegacyHeartbeatTasks } from "../commands/heartbeat-task-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";
import { hashCronScratchSource } from "../cron/scratch-store.js";
import type { CronJob } from "../cron/types.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { AgentDeletionWorkerWriteAuthority } from "../state/agent-deletion-journal.types.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  CLAW_PORTABLE_HEARTBEAT_ID,
  type ClawPortableHeartbeat,
  type ClawCronGateway,
} from "./cron.js";
import { ClawExportError } from "./export-error.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { assertPortableHeartbeatUnchanged } from "./portable-heartbeat-state.kernel.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";
import { mutatePortableHeartbeat } from "./portable-heartbeat-write.js";
import type { PersistedClawInstall } from "./provenance-types.js";
import { parseClawOpenClawProfile } from "./schema.js";
import type { ClawAddPlan, ClawAddPlanAction } from "./types.js";
import { readClawWorkspaceActionSource } from "./workspace.js";

const DEFAULT_INTERVAL_MS = 30 * 60_000;

export function planPortableHeartbeat(
  actions: ClawAddPlanAction[],
  heartbeat: ClawPortableHeartbeat | undefined,
  agentId: string,
): ClawAddPlanAction | undefined {
  const fileIndex = actions.findIndex(
    (action) => action.kind === "workspaceFile" && action.id === "HEARTBEAT.md",
  );
  if (heartbeat === undefined && fileIndex < 0) {
    return undefined;
  }
  const file = fileIndex < 0 ? undefined : actions.splice(fileIndex, 1)[0];
  const action: ClawAddPlanAction = {
    ...file,
    kind: "cronJob",
    id: CLAW_PORTABLE_HEARTBEAT_ID,
    action: "schedule",
    target: `automation:${agentId}`,
    blocked: file?.blocked ?? false,
    details: { heartbeat: heartbeat ?? {} },
    reason:
      "Import deprecated portable heartbeat as an ordinary automation and bounded scratch; no runtime heartbeat configuration is installed.",
  };
  actions.push(action);
  return action;
}

export function portableHeartbeatJob(
  cfg: OpenClawConfig,
  agentId: string,
  heartbeat: ClawPortableHeartbeat,
  nowMs: number,
): CronJob {
  const everyMs = parseDurationMs(heartbeat.every ?? "30m", { defaultUnit: "m" });
  const job = createDefaultProactiveJob(cfg, agentId, nowMs, everyMs || DEFAULT_INTERVAL_MS);
  job.enabled = everyMs > 0;
  if (!job.enabled) {
    delete job.state.nextRunAtMs;
  }
  job.sessionTarget = heartbeat.isolatedSession ? "isolated" : job.sessionTarget;
  job.activeHours = heartbeat.activeHours
    ? {
        start: heartbeat.activeHours.start ?? "00:00",
        end: heartbeat.activeHours.end ?? "24:00",
        ...(heartbeat.activeHours.timezone ? { timezone: heartbeat.activeHours.timezone } : {}),
      }
    : undefined;
  if (job.payload.kind === "agentTurn") {
    job.payload.timeoutSeconds =
      heartbeat.timeoutSeconds ??
      cfg.agents?.defaults?.timeoutSeconds ??
      Math.max(1, Math.min(600, Math.ceil((everyMs || 600_000) / 1000)));
    if (heartbeat.lightContext !== undefined) {
      job.payload.lightContext = heartbeat.lightContext;
    }
  }
  return job;
}

export async function readPortableHeartbeatSource(
  plan: ClawAddPlan,
): Promise<{ heartbeat: ClawPortableHeartbeat; scratch?: string } | undefined> {
  const action = plan.actions.find(
    (item) => item.kind === "cronJob" && item.id === CLAW_PORTABLE_HEARTBEAT_ID,
  );
  if (!action) {
    return undefined;
  }
  const parsed = parseClawOpenClawProfile({
    schemaVersion: 1,
    agent: { heartbeat: action.details?.heartbeat },
  });
  if (!parsed.ok || !parsed.profile.agent.heartbeat) {
    throw new Error("Invalid portable heartbeat declaration; rebuild the Claw plan.");
  }
  const heartbeat = parsed.profile.agent.heartbeat;
  if (!action.source) {
    return { heartbeat };
  }
  const file = await readClawWorkspaceActionSource({
    action,
    packageRoot: plan.claw.packageRoot,
    sourceRoot: await fsSafeRoot(plan.claw.packageRoot),
  });
  // ignoreBOM preserves the original UTF-8 bytes, including a leading BOM.
  const scratch = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content);
  assertCronJobScratchContent(scratch);
  if (`sha256:${hashCronScratchSource(scratch)}` !== action.digest) {
    throw new Error("Portable HEARTBEAT.md changed after consent; rebuild the Claw plan.");
  }
  return { heartbeat, scratch };
}

async function commitPortableHeartbeatImport(
  plan: ClawAddPlan,
  cfg: OpenClawConfig,
  source: NonNullable<Awaited<ReturnType<typeof readPortableHeartbeatSource>>>,
  options: OpenClawStateDatabaseOptions,
): Promise<PortableHeartbeatState> {
  const previous = await readPortableHeartbeatState(plan.agent.finalId, cfg, options);
  const nowMs = Date.now();
  return (
    await mutatePortableHeartbeat(
      {
        kind: "import",
        agentId: plan.agent.finalId,
        storePath: previous.storePath,
        expected: previous,
        nowMs,
        plannedJob: portableHeartbeatJob(cfg, plan.agent.finalId, source.heartbeat, nowMs),
        source,
      },
      options,
    )
  ).state;
}

/** Existing cron inventory is the cross-process adoption acknowledgement, never an upsert. */
export async function publishPortableHeartbeat(
  agentId: string,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions & {
    cronGateway?: Pick<ClawCronGateway, "list" | "waitUntilAgentAvailable">;
  },
): Promise<void> {
  const gateway = options.cronGateway;
  if (!gateway) {
    return;
  } // Offline library installs load normally on the next scheduler start.
  if (!gateway.list) {
    throw new Error("Portable automation publication requires the gateway cron.list API.");
  }
  const current = await readPortableHeartbeatState(agentId, cfg, options);
  if (!current.receipt) {
    return;
  }
  await gateway.waitUntilAgentAvailable?.(agentId);
  const result = await gateway.list(agentId);
  if (!isRecord(result) || !Array.isArray(result.jobs)) {
    throw new Error("cron.list did not acknowledge the committed portable automation.");
  }
  const live = result.jobs.find((job) => isRecord(job) && job.id === current.receipt!.jobId);
  if (
    current.job
      ? !Value.Check(CronJobSchema, live) ||
        // SAFETY: Its session-target regex enforces the TS template union that TypeBox types as string.
        resolveCronJobConfigRevision(cronJobDefinitionFromReadView(live as CronJob) as CronJob) !==
          resolveCronJobConfigRevision(current.job)
      : live !== undefined
  ) {
    throw new Error(
      `Automation ${current.receipt.jobId} changed or was not adopted by the Gateway; inspect cron list before retrying. No job was recreated.`,
    );
  }
  assertPortableHeartbeatUnchanged(
    await readPortableHeartbeatState(agentId, cfg, options),
    current,
  );
}

export async function installPortableHeartbeat(
  plan: ClawAddPlan,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions & {
    cronGateway?: Pick<ClawCronGateway, "list" | "waitUntilAgentAvailable">;
  },
): Promise<void> {
  const source = await readPortableHeartbeatSource(plan);
  if (!source) {
    return;
  }
  const imported = await commitPortableHeartbeatImport(plan, cfg, source, options);
  if (source.scratch !== undefined && analyzeLegacyHeartbeatTasks(source.scratch).hasTasksBlock) {
    if (!imported.receipt) {
      throw new Error("Portable task import has no provisioning receipt.");
    }
    const sourceScratchDigest = hashCronScratchSource(source.scratch);
    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg,
      env: options.env,
      shouldRepair: true,
    });
    if (result.warnings.length) {
      throw new Error(result.warnings.join("\n"));
    }
    await mutatePortableHeartbeat(
      {
        kind: "completeTasks",
        agentId: plan.agent.finalId,
        storePath: imported.storePath,
        jobId: imported.receipt.jobId,
        nowMs: Date.now(),
        sourceScratchDigest,
      },
      options,
    );
  }
  await publishPortableHeartbeat(plan.agent.finalId, cfg, options);
}

function duration(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms}ms`;
}

export async function exportPortableHeartbeat(
  agentId: string,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
): Promise<{ heartbeat: ClawPortableHeartbeat; scratch?: string } | undefined> {
  const state = await readPortableHeartbeatState(agentId, cfg, options);
  if (!state.ref && !state.receipt) {
    return undefined;
  }
  const jobId = state.receipt?.jobId ?? state.ref?.schedulerJobId ?? "unknown";
  const reject = (fields: string[]): never => {
    throw new ClawExportError(
      "heartbeat_not_representable",
      `Automation ${jobId} cannot be exported through deprecated portable agent.heartbeat: ${fields.join(", ")}. Keep the ordinary automation locally or explicitly edit it to a representable configuration; no output was created.`,
    );
  };
  const { job, ref, receipt } = state;
  if (
    !receipt ||
    receipt.phase !== "complete" ||
    (ref &&
      (ref.status === "pending" || ref.status === "failed" || ref.schedulerJobId !== receipt.jobId))
  ) {
    return reject(["unresolved ownership"]);
  }
  if (!job) {
    return reject(["deleted job (the artifact cannot encode tombstones)"]);
  }
  const fields: string[] = [];
  if (receipt.convertedJobIds?.length) {
    fields.push(`converted task jobs (${receipt.convertedJobIds.join(", ")})`);
  }
  if (job.schedule.kind !== "every") {
    fields.push("schedule.kind");
  }
  const everyMs = job.schedule.kind === "every" ? job.schedule.everyMs : 0;
  const zeroSource =
    ref !== undefined &&
    parseDurationMs(ref.job.heartbeat.every ?? "30m", { defaultUnit: "m" }) === 0;
  if (!job.enabled && !(zeroSource && everyMs === DEFAULT_INTERVAL_MS)) {
    fields.push("enabled + retained cadence");
  }
  const heartbeat: ClawPortableHeartbeat = {
    every: job.enabled ? duration(everyMs) : "0m",
    ...(job.activeHours ? { activeHours: job.activeHours } : {}),
    isolatedSession: job.sessionTarget === "isolated",
    ...(job.payload.kind === "agentTurn" && job.payload.lightContext !== undefined
      ? { lightContext: job.payload.lightContext }
      : {}),
    ...(job.payload.kind === "agentTurn" && job.payload.timeoutSeconds !== undefined
      ? { timeoutSeconds: job.payload.timeoutSeconds }
      : {}),
  };
  const validation = parseClawOpenClawProfile({ schemaVersion: 1, agent: { heartbeat } });
  if (!validation.ok) {
    fields.push(...validation.diagnostics.map((entry) => entry.path));
  }
  if (job.state.autoDisabled) {
    fields.push("state.autoDisabled");
  }
  const expected = portableHeartbeatJob(cfg, agentId, heartbeat, job.createdAtMs);
  // Local identity, phase, history and scratch revisions are not artifact data.
  // All execution/security fields must otherwise match an actual round-trip.
  const ignored = new Set([
    "id",
    "name",
    "displayName",
    "description",
    "createdAtMs",
    "updatedAtMs",
    "state",
    "schedule",
  ]);
  const actualFields = new Map(Object.entries(job));
  const expectedFields = new Map(Object.entries(expected));
  for (const key of new Set([...actualFields.keys(), ...expectedFields.keys()])) {
    if (ignored.has(key)) {
      continue;
    }
    const actual = actualFields.get(key);
    const wanted = expectedFields.get(key);
    if (!isDeepStrictEqual(actual, wanted)) {
      if (key === "payload") {
        for (const field of new Set([
          ...Object.keys(job.payload),
          ...Object.keys(expected.payload),
        ])) {
          if (
            !isDeepStrictEqual(
              Object.fromEntries(Object.entries(job.payload))[field],
              Object.fromEntries(Object.entries(expected.payload))[field],
            )
          ) {
            fields.push(`payload.${field}`);
          }
        }
      } else {
        fields.push(key);
      }
    }
  }
  if (fields.length) {
    reject(fields);
  }
  return {
    heartbeat,
    ...(state.scratch.scratch ? { scratch: state.scratch.scratch.content } : {}),
  };
}

export async function removePortableHeartbeat(
  agentId: string,
  cfg: OpenClawConfig,
  expected: PortableHeartbeatState,
  options: OpenClawStateDatabaseOptions & {
    cronGateway?: Pick<ClawCronGateway, "get" | "remove">;
    assertCurrent: () => void;
    workerAuthority: AgentDeletionWorkerWriteAuthority;
    expectedInstall: PersistedClawInstall | null;
  },
): Promise<void> {
  const gateway = options.cronGateway;
  if (expected.job) {
    if (!gateway?.get) {
      throw new Error(
        "Portable automation removal requires the serving Gateway cron.get and cron.remove APIs.",
      );
    }
    await gateway.get(expected.job.id);
    options.assertCurrent();
    assertPortableHeartbeatUnchanged(
      await readPortableHeartbeatState(agentId, cfg, options),
      expected,
    );
    options.assertCurrent();
    try {
      await gateway.remove(expected.job.id);
    } catch (error) {
      if ((await gateway.get(expected.job.id)) != null) {
        throw error;
      }
    }
  }
  options.assertCurrent();
  await mutatePortableHeartbeat(
    {
      kind: "removeRef",
      agentId,
      storePath: expected.storePath,
      nowMs: Date.now(),
      expected,
      deletion: options.workerAuthority.facts,
      expectedInstall: options.expectedInstall,
    },
    { ...options, assertCurrent: options.workerAuthority.assertCurrent },
  );
}
