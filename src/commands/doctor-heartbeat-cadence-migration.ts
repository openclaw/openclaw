import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDefaultProactiveJob,
  DEFAULT_PROACTIVE_PROMPT,
  resolveDefaultProactiveCadenceMs,
} from "../cron/default-proactive-job.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
  recordConvertedProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { finalizeUpdatedJob } from "../cron/service/jobs-mutation.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { assertExecutionPolicy } from "../cron/service/jobs-validation.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, upsertCronJobRow } from "../cron/store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "../cron/store/runtime-authority-store.js";
import type { CronStoredJob as CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  decodeDoctorHeartbeatJobRows,
  readDoctorHeartbeatJobs,
  type DoctorCronJob,
} from "./doctor-heartbeat-jobs.js";
import {
  resolveHeartbeatAgents,
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
  migrateHeartbeatPrompt,
  validateLegacyHeartbeatConfig,
} from "./doctor-heartbeat-legacy.js";
import {
  resolveHeartbeatPhaseMs,
  resolveHeartbeatSchedulerSeed,
} from "./doctor-heartbeat-schedule.js";
import { resolveHeartbeatSessionKey } from "./doctor-heartbeat-session.js";
import { isHeartbeatTaskCronJob } from "./doctor-heartbeat-task-identity.js";
import { resolveHeartbeatVisibility } from "./doctor-heartbeat-visibility.js";

const CHECK_ID = "core/doctor/heartbeat-cadence-migration";

function isGeneratedMonitor(job: DoctorCronJob): boolean {
  return job.payload.kind === "heartbeat" && job.declarationKey === `heartbeat:${job.agentId}`;
}

function isPendingLegacyHeartbeatRetry(job: DoctorCronJob): job is CronJob & {
  payload: Extract<CronJob["payload"], { kind: "systemEvent" }>;
} {
  return (
    job.schedule.kind === "at" &&
    job.sessionTarget === "main" &&
    job.payload.kind === "systemEvent" &&
    (job.state.lastRunStatus ?? job.state.lastStatus) === "skipped" &&
    job.state.lastError === "disabled" &&
    typeof job.state.lastRunAtMs === "number" &&
    typeof job.state.nextRunAtMs === "number" &&
    job.state.nextRunAtMs > job.state.lastRunAtMs &&
    job.state.startupCatchupAtMs !== job.state.nextRunAtMs
  );
}

function legacyAlertsEnabled(cfg: OpenClawConfig, target: string, accountId?: string): boolean {
  const channels =
    target !== "owner" && target !== "last" && target !== "none"
      ? [target]
      : Object.keys(cfg.channels ?? {}).filter(
          (key) => key !== "defaults" && key !== "modelByChannel",
        );
  const values = new Set(
    (channels.length ? channels : ["webchat"]).flatMap((channel) => {
      const config = cfg.channels?.[channel];
      const accounts =
        isRecord(config) && isRecord(config.accounts) ? Object.keys(config.accounts) : [];
      return (accountId ? [accountId] : accounts.length ? accounts : [undefined]).map(
        (id) => resolveHeartbeatVisibility({ cfg, channel, accountId: id }).showAlerts,
      );
    }),
  );
  if (values.size !== 1) {
    throw new Error(
      "Mixed channel/account heartbeat alert visibility cannot be preserved by a dynamic owner automation. Make heartbeatVisibility.showAlerts consistent, then rerun Doctor; legacy input was retained.",
    );
  }
  return values.has(true);
}

function migrateActiveHours(heartbeat: ReturnType<typeof resolveHeartbeatConfig>) {
  const active = heartbeat?.activeHours;
  // The previous evaluator treated incomplete windows as unrestricted.
  if (!active?.start || !active.end) {
    return undefined;
  }
  let timezone = active.timezone?.trim() || "user";
  if (timezone !== "user" && timezone !== "local") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      // Legacy explicit zones fell back to the current user timezone.
      timezone = "user";
    }
  }
  return { start: active.start, end: active.end, timezone };
}

function convertMonitor(
  cfg: OpenClawConfig,
  agentId: string,
  previous: DoctorCronJob | undefined,
  nowMs: number,
  schedulerSeed: string,
  env: NodeJS.ProcessEnv,
): CronJob {
  const heartbeat = resolveHeartbeatConfig(cfg, agentId);
  // A persisted monitor already resolved provider defaults such as OAuth's 1h
  // cadence. Only an authored cadence supersedes that accepted schedule.
  const intervalMs =
    heartbeat?.every === undefined
      ? ((previous?.schedule.kind === "every"
          ? previous.schedule.everyMs
          : resolveDefaultProactiveCadenceMs(cfg, agentId, env)) ??
        resolveHeartbeatIntervalMs(cfg, undefined, heartbeat))
      : resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  const job: CronJob = previous
    ? {
        ...structuredClone(previous),
        payload: { kind: "agentTurn", message: DEFAULT_PROACTIVE_PROMPT },
      }
    : createDefaultProactiveJob(cfg, agentId, nowMs);
  const session = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, undefined, env);
  const target = heartbeat?.target?.trim() || "owner";
  job.payload = {
    kind: "agentTurn",
    message: heartbeat?.prompt?.trim()
      ? migrateHeartbeatPrompt(heartbeat.prompt)
      : DEFAULT_PROACTIVE_PROMPT,
    skipIfScratchEmpty: true,
    ...(previous?.payload.toolsAllow ? { toolsAllow: previous.payload.toolsAllow } : {}),
    ...(previous?.payload.toolsAllowIsDefault !== undefined
      ? { toolsAllowIsDefault: previous.payload.toolsAllowIsDefault }
      : {}),
    ...(heartbeat?.model ? { model: heartbeat.model } : {}),
    timeoutSeconds:
      heartbeat?.timeoutSeconds ??
      cfg.agents?.defaults?.timeoutSeconds ??
      Math.max(1, Math.min(600, Math.ceil((intervalMs ?? 600_000) / 1000))),
    ...(heartbeat?.lightContext !== undefined ? { lightContext: heartbeat.lightContext } : {}),
  };
  job.sessionKey = session.sessionKey;
  job.sessionTarget = heartbeat?.isolatedSession ? "isolated" : `session:${session.sessionKey}`;
  job.wakeMode = "now";
  job.idleOnly = true;
  job.activeHours = migrateActiveHours(heartbeat);
  job.delivery = {
    mode:
      target === "none" || !legacyAlertsEnabled(cfg, target, heartbeat?.accountId)
        ? "none"
        : "announce",
    ...(target === "owner"
      ? { target: "owner" as const }
      : target !== "none"
        ? { channel: target }
        : {}),
    ...(target !== "owner" && target !== "none" && heartbeat?.to ? { to: heartbeat.to } : {}),
    ...(heartbeat?.accountId ? { accountId: heartbeat.accountId } : {}),
    ...(heartbeat?.directPolicy ? { directPolicy: heartbeat.directPolicy } : {}),
  };
  if (!previous || isGeneratedMonitor(previous)) {
    delete job.declarationKey;
  }
  if (!previous) {
    job.enabled = intervalMs !== null;
    const everyMs = intervalMs ?? 30 * 60 * 1000;
    job.schedule = {
      kind: "every",
      everyMs,
      anchorMs: resolveHeartbeatPhaseMs({ schedulerSeed, agentId, intervalMs: everyMs }),
    };
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
  } else if (isGeneratedMonitor(previous)) {
    // Config was the generated monitor's desired state, not merely its create default.
    // Preserve independent disable state and unchanged anchors/slots at ownership transfer.
    job.enabled = previous.enabled && intervalMs !== null;
    if (
      intervalMs !== null &&
      (previous.schedule.kind !== "every" || previous.schedule.everyMs !== intervalMs)
    ) {
      job.schedule = {
        kind: "every",
        everyMs: intervalMs,
        anchorMs: resolveHeartbeatPhaseMs({ schedulerSeed, agentId, intervalMs }),
      };
    }
    const scheduleChanged = !isDeepStrictEqual(previous.schedule, job.schedule);
    if (scheduleChanged || previous.enabled !== job.enabled) {
      finalizeUpdatedJob({
        job: { ...previous, payload: job.payload },
        nextJob: job,
        now: nowMs,
        schedulingInputsRequested: true,
        scheduleChanged,
      });
    }
  }
  job.updatedAtMs = nowMs;
  assertExecutionPolicy(job);
  return job;
}

/** Receipt lookup never recreates a previously provisioned/deleted job or overwrites edits. */
export async function ensureHeartbeatMonitorJobs(
  cfg: OpenClawConfig,
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, CronJob>> {
  validateLegacyHeartbeatConfig(cfg);
  const schedulerSeed = resolveHeartbeatSchedulerSeed(undefined, { env });
  const loaded = readDoctorHeartbeatJobs(storePath, env);
  const configuredAgentIds = new Set(listAgentIds(cfg));
  const enrolledAgentIds = new Set(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId));
  const agentIds = new Set(enrolledAgentIds);
  for (const job of loaded) {
    if (job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job)) {
      if (!job.agentId) {
        throw new Error(
          `Legacy monitor ${job.id} has no agent owner; assign its owner before Doctor cutover.`,
        );
      }
      if (!configuredAgentIds.has(job.agentId)) {
        throw new Error(
          `Legacy automation ${job.id} belongs to unconfigured agent ${job.agentId}; restore its owner before cutover.`,
        );
      }
      if (
        job.payload.kind === "heartbeat" &&
        job.declarationKey?.startsWith("heartbeat:") &&
        !isGeneratedMonitor(job)
      ) {
        throw new Error(
          `Legacy monitor ${job.id} has conflicting declaration ${job.declarationKey} and agent ${job.agentId}. Restore its original owner/declaration from backup before rerunning Doctor; legacy config and rows were retained.`,
        );
      }
      agentIds.add(job.agentId);
    }
  }
  for (const agentId of listAgentIds(cfg)) {
    const receipt = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
      { env },
    );
    if (receipt) {
      agentIds.add(agentId);
    }
  }
  const nowMs = Date.now();
  const planned = [...agentIds].toSorted().flatMap((agentId) => {
    const legacyJobs = loaded.filter(
      (job) => job.payload.kind === "heartbeat" && job.agentId === agentId,
    );
    const matches = legacyJobs.filter(isGeneratedMonitor);
    if (matches.length > 1) {
      throw new Error(
        `Multiple legacy monitors for ${agentId}; resolve the duplicate ownership before cutover.`,
      );
    }
    const job = convertMonitor(cfg, agentId, matches[0], nowMs, schedulerSeed, env);
    if (!matches[0] && !enrolledAgentIds.has(agentId)) {
      job.enabled = false;
      delete job.state.nextRunAtMs;
    }
    // Row-only jobs retain their own schedule and identity; only the generated
    // monitor receives the default receipt and imported agent scratch.
    const conversions = [{ agentId, previous: matches[0], job, defaultMonitor: true }];
    for (const previous of legacyJobs) {
      if (!isGeneratedMonitor(previous)) {
        conversions.push({
          agentId,
          previous,
          job: convertMonitor(cfg, agentId, previous, nowMs, schedulerSeed, env),
          defaultMonitor: false,
        });
      }
    }
    return conversions;
  });
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(db, cronStoreKey(storePath));
      const currentJobs = decodeDoctorHeartbeatJobRows(rows);
      const result = new Map<string, CronJob>();
      let nextSortOrder = rows.reduce((max, row) => Math.max(max, row.sort_order + 1), 0);
      for (const previous of loaded.filter(isPendingLegacyHeartbeatRetry)) {
        const current = currentJobs.find((job) => job.id === previous.id);
        if (
          !current ||
          current.payload.kind !== "systemEvent" ||
          !isDeepStrictEqual(current, previous) ||
          current.state.runningAtMs !== undefined
        ) {
          throw new Error(
            `Pending automation ${previous.id} changed during Doctor planning; stop the Gateway and retry.`,
          );
        }
        // The old runner's disabled result never executed the pending slot. Transfer
        // it to cron's existing catch-up owner without rewriting history or cadence.
        upsertCronJobRow(
          db,
          cronStoreKey(storePath),
          {
            ...current,
            payload: current.payload,
            state: { ...current.state, startupCatchupAtMs: current.state.nextRunAtMs },
          },
          rows.find((row) => row.job_id === current.id)!.sort_order,
        );
      }
      for (const item of planned) {
        const receipt = item.defaultMonitor
          ? readDefaultProactiveJobReceiptInDatabase(db, storePath, item.agentId)
          : undefined;
        if (receipt) {
          if (item.previous && item.previous.id !== receipt.jobId) {
            throw new Error(
              `Agent ${item.agentId} has a legacy monitor outside its cutover receipt; resolve the conflicting job before stripping legacy configuration.`,
            );
          }
          const current = currentJobs.find((job) => job.id === receipt.jobId);
          if (!current && receipt.phase !== "complete") {
            throw new Error(
              `Agent ${item.agentId} has an incomplete cutover whose job ${receipt.jobId} was deleted. Restore the job from backup or resolve its remaining legacy data before rerunning Doctor; it will not be recreated.`,
            );
          }
          if (
            current &&
            receipt.phase !== "complete" &&
            (current.agentId !== item.agentId || current.payload.kind !== "agentTurn")
          ) {
            throw new Error(
              `Automation ${current.id} changed owner or payload during an incomplete cutover; legacy inputs were retained.`,
            );
          }
          if (current) {
            if (current.payload.kind === "heartbeat") {
              throw new Error(`Automation ${current.id} retained a legacy payload after cutover.`);
            }
            result.set(item.agentId, { ...current, payload: current.payload });
          }
          continue;
        }
        const current = item.previous
          ? currentJobs.find((job) => job.id === item.previous!.id)
          : undefined;
        if (
          (item.previous && (!current || !isDeepStrictEqual(current, item.previous))) ||
          (!item.previous &&
            currentJobs.some((job) => isGeneratedMonitor(job) && job.agentId === item.agentId))
        ) {
          throw new Error(
            `Agent ${item.agentId} automation changed during Doctor planning; no cutover committed. Rerun Doctor.`,
          );
        }
        if (current?.state.runningAtMs !== undefined) {
          throw new Error(
            `Automation ${current.id} is running; stop the Gateway and rerun Doctor to preserve its execution boundary.`,
          );
        }
        const sortOrder = current
          ? rows.find((row) => row.job_id === current.id)!.sort_order
          : nextSortOrder++;
        // The authority companion may have changed while planning awaited IO. Carry
        // the freshly validated owner, never the snapshot, across the payload conversion.
        const authoritySource: CronJob = current
          ? {
              ...current,
              // Heartbeat and systemEvent both used the non-tool-runtime input
              // fingerprint. Validate the original authority before rebinding it
              // to agentTurn, whose fingerprint deliberately changes that bit.
              payload:
                current.payload.kind === "heartbeat"
                  ? { ...current.payload, kind: "systemEvent", text: "" }
                  : current.payload,
            }
          : item.job;
        loadCronRuntimeAuthorities({
          db,
          storeKey: cronStoreKey(storePath),
          jobs: [authoritySource],
        });
        item.job.runtimeAuthority = authoritySource.runtimeAuthority;
        item.job.runtimeAuthorityRecoveryRequired =
          authoritySource.runtimeAuthorityRecoveryRequired;
        // The transaction already revalidated the full row. Persist scheduling state
        // together with its changed definition instead of retaining the stale slot.
        const job = upsertCronJobRow(db, cronStoreKey(storePath), item.job, sortOrder);
        replaceCronRuntimeAuthorityRows({
          db,
          storeKey: cronStoreKey(storePath),
          jobs: [item.job],
        });
        if (item.defaultMonitor) {
          recordDefaultProactiveJobInDatabase(
            db,
            storePath,
            item.agentId,
            job.id,
            nowMs,
            "pending",
          );
          result.set(item.agentId, job);
        } else {
          recordConvertedProactiveJobInDatabase(db, storePath, item.agentId, job.id);
        }
      }
      return result;
    },
    { env },
    { operationLabel: "doctor.heartbeat-retirement" },
  );
}

export async function collectHeartbeatCadenceMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  try {
    const loaded = readDoctorHeartbeatJobs(storePath, env);
    const pending = resolveHeartbeatAgents(cfg).filter(
      (agent) =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agent.agentId),
          { env },
        )?.phase !== "complete",
    );
    if (
      !pending.length &&
      !loaded.some(
        (job) =>
          job.payload.kind === "heartbeat" ||
          isHeartbeatTaskCronJob(job) ||
          isPendingLegacyHeartbeatRetry(job),
      )
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        path: storePath,
        message: "Legacy heartbeat state must become ordinary editable automations.",
        requirement: "heartbeat-retirement",
        fixHint: "Run openclaw doctor --fix before starting the Gateway.",
      },
    ];
  } catch (error) {
    return [
      {
        checkId: CHECK_ID,
        severity: "error",
        path: storePath,
        message: formatErrorMessage(error),
        requirement: "heartbeat-retirement-inspection",
        fixHint: "Resolve the state error and rerun openclaw doctor --fix.",
      },
    ];
  }
}

export async function maybeMigrateHeartbeatCadenceToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const findings = await collectHeartbeatCadenceMigrationFindings(params.cfg, params.env);
  if (!params.shouldRepair || !findings.length) {
    return { changes: [], warnings: findings.map((finding) => finding.message) };
  }
  try {
    await ensureHeartbeatMonitorJobs(
      params.cfg,
      resolveCronJobsStorePathFromConfig(params.cfg, params.env),
      params.env,
    );
    const changes = [
      "Converted legacy heartbeat cadence to ordinary editable automations; recorded one-way provisioning receipts.",
    ];
    note(changes.join("\n"), "Doctor changes");
    return { changes, warnings: [] };
  } catch (error) {
    const warnings = [formatErrorMessage(error)];
    note(warnings.join("\n"), "Doctor warnings");
    return { changes: [], warnings };
  }
}
