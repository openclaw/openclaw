import { randomUUID } from "node:crypto";
import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  asFiniteNumber,
  timestampMsToIsoString,
} from "../../../../packages/normalization-core/src/number-coercion.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { classifyCronAgentTurnShellPrompt } from "../../../cron/agent-turn-command-prompt.js";
import { parseAbsoluteTimeMs } from "../../../cron/parse.js";
import { getInvalidPersistedCronJobReason } from "../../../cron/persisted-shape.js";
import { coerceFiniteScheduleNumber } from "../../../cron/schedule-number.js";
import { inferCronJobName } from "../../../cron/service/normalize.js";
import { resolveCronCurrentSessionTarget } from "../../../cron/session-target.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "../../../cron/stagger.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../../../cron/types-shared.js";
import {
  hasLegacyToolNameList,
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "../shared/legacy-tool-name-migration.js";
import { normalizeLegacyDeliveryInput } from "./legacy-delivery.js";
import {
  collectLegacyOpenAICodexCronModelRoutes,
  copyTopLevelAgentTurnFields,
  inferPayloadIfMissing,
  migrateLegacyAgentTurnCommandPayload,
  migrateLegacyCronPayload,
  normalizePayloadKind,
  stripLegacyTopLevelFields,
} from "./payload-migration.js";
import { migrateScheduledToolPolicy } from "./scheduled-tool-policy-migration.js";
import { migrateLegacyCronTriggerScript } from "./trigger-script-migration.js";

type CronStoreIssueKey =
  | "jobId"
  | "missingId"
  | "nonStringId"
  | "legacyScheduleString"
  | "legacyScheduleCron"
  | "legacyScheduleKind"
  | "legacyPayloadKind"
  | "legacyPayloadCodexModel"
  | "legacyImageInspectionToolName"
  | "legacyTaskSuggestionToolName"
  | "legacyAgentTurnCommandPayload"
  | "unresolvedAgentTurnShellToolPrompt"
  | "legacyPayloadProvider"
  | "legacyTopLevelPayloadFields"
  | "legacyTopLevelDeliveryFields"
  | "legacyDeliveryMode"
  | "migratedScheduledToolPolicy"
  | "reconciledOwnerAccount"
  | "invalidSchedule"
  | "invalidPayload";

type CronStoreIssues = Partial<Record<CronStoreIssueKey, number>>;

export type CronCodexRuntimePolicyTarget = {
  agentId?: string;
  modelRef: string;
  legacyModelRef?: string;
};

export function cronCodexRuntimePolicyTargetKey(target: CronCodexRuntimePolicyTarget): string {
  return `${target.agentId ?? ""}\u0000${target.modelRef}\u0000${target.legacyModelRef ?? ""}`;
}

export function collectStoredCronCodexRuntimePolicyTargets(
  jobs: ReadonlyArray<Record<string, unknown>>,
): CronCodexRuntimePolicyTarget[] {
  const targets = new Map<string, CronCodexRuntimePolicyTarget>();
  for (const job of jobs) {
    const agentId = normalizeOptionalString(job.agentId);
    const payload = isRecord(job.payload) ? job.payload : {};
    const routes = [
      ...collectLegacyOpenAICodexCronModelRoutes(payload),
      ...collectLegacyOpenAICodexCronModelRoutes({ model: job.model }),
    ];
    for (const route of routes) {
      const target = {
        ...(agentId ? { agentId } : {}),
        modelRef: route.canonicalModelRef,
        legacyModelRef: route.legacyModelRef,
      };
      targets.set(cronCodexRuntimePolicyTargetKey(target), target);
    }
  }
  return [...targets.values()];
}

type NormalizeCronStoreJobsResult = {
  codexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[];
  issues: CronStoreIssues;
  unresolvedAgentTurnCommandPromptJobs: string[];
  unresolvedAgentTurnShellToolPromptJobs: string[];
  legacyTriggerScriptJobs: string[];
  unsupportedLegacyTriggerScriptJobs: string[];
  unsupportedDeliveryModeJobs: string[];
  legacyScheduledToolPolicyJobs: string[];
  invalidScheduledToolPolicyJobs: string[];
  legacyGatewayExecJobs: string[];
  jobs: Array<Record<string, unknown>>;
  mutated: boolean;
  removedJobs: Array<{ job: Record<string, unknown>; reason: string; sourceIndex: number }>;
};

function normalizeStoredCronJobIdentity(
  raw: Record<string, unknown>,
  trackIssue: (key: CronStoreIssueKey) => void,
): boolean {
  const id = normalizeOptionalStringifiedId(raw.id);
  const legacyJobId = normalizeOptionalStringifiedId(raw.jobId);
  const canonicalId = id ?? legacyJobId ?? `cron-${randomUUID()}`;
  const hadJobIdKey = "jobId" in raw;
  if (hadJobIdKey) {
    trackIssue("jobId");
  }
  if (!id && !legacyJobId) {
    trackIssue("missingId");
  }
  if ("id" in raw && raw.id != null && typeof raw.id !== "string") {
    trackIssue("nonStringId");
  }
  const mutated = raw.id !== canonicalId || hadJobIdKey;
  raw.id = canonicalId;
  delete raw.jobId;
  return mutated;
}

function resolveLegacyCronDeliveryMode(mode: unknown): "none" | "announce" | "webhook" | undefined {
  if (mode === undefined || mode === null) {
    return "announce";
  }
  const normalized = normalizeOptionalLowercaseString(mode);
  if (normalized === "deliver") {
    return "announce";
  }
  return normalized === "none" || normalized === "announce" || normalized === "webhook"
    ? normalized
    : undefined;
}

/** Unknown delivery intent must remain untouched until the operator supplies a supported mode. */
export function canRepairCronDeliveryForDoctor(delivery: unknown): boolean {
  return (
    delivery === undefined ||
    (isRecord(delivery) && resolveLegacyCronDeliveryMode(delivery.mode) !== undefined)
  );
}

/** Normalize persisted cron jobs in place and report issues plus rows to quarantine. */
export function normalizeStoredCronJobs(
  jobs: Array<Record<string, unknown>>,
  options: {
    migrateCodexModelRefs?: boolean;
    shouldMigrateCodexRuntimePolicyTarget?: (target: CronCodexRuntimePolicyTarget) => boolean;
  } = {},
): NormalizeCronStoreJobsResult {
  const issues: CronStoreIssues = {};
  const unresolvedAgentTurnCommandPromptJobs: string[] = [];
  const unresolvedAgentTurnShellToolPromptJobs: string[] = [];
  const legacyTriggerScriptJobs: string[] = [];
  const unsupportedLegacyTriggerScriptJobs: string[] = [];
  const unsupportedDeliveryModeJobs: string[] = [];
  const legacyGatewayExecJobs: string[] = [];
  const legacyScheduledToolPolicyJobs: string[] = [];
  const invalidScheduledToolPolicyJobs: string[] = [];
  const unresolvedAgentTurnPromptJobsByKind = {
    commandPromptWithoutShellAccess: unresolvedAgentTurnCommandPromptJobs,
    shellToolPrompt: unresolvedAgentTurnShellToolPromptJobs,
  };
  let mutated = false;
  const keptJobs: Array<Record<string, unknown>> = [];
  const removedJobs: NormalizeCronStoreJobsResult["removedJobs"] = [];
  const codexRuntimePolicyTargets = new Map<string, CronCodexRuntimePolicyTarget>();

  for (const [sourceIndex, raw] of jobs.entries()) {
    if (!canRepairCronDeliveryForDoctor(raw.delivery)) {
      unsupportedDeliveryModeJobs.push(storedCronJobId(raw) ?? "<unnamed>");
      keptJobs.push(raw);
      continue;
    }
    const jobIssues = new Set<CronStoreIssueKey>();
    const trackIssue = (key: CronStoreIssueKey) => {
      if (jobIssues.has(key)) {
        return;
      }
      jobIssues.add(key);
      issues[key] = (issues[key] ?? 0) + 1;
    };
    const trackChange = (key: CronStoreIssueKey) => {
      mutated = true;
      trackIssue(key);
    };
    const setField = (record: Record<string, unknown>, key: string, value: unknown) => {
      if (record[key] !== value) {
        record[key] = value;
        mutated = true;
      }
    };

    const identityMutated = normalizeStoredCronJobIdentity(raw, trackIssue);
    mutated ||= identityMutated;

    if (!isRecord(raw.state)) {
      setField(raw, "state", {});
    }

    if (typeof raw.schedule === "string") {
      setField(raw, "schedule", { kind: "cron", expr: raw.schedule.trim() });
      trackIssue("legacyScheduleString");
    }

    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferCronJobName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const trigger = raw.trigger;
    if (isRecord(trigger) && typeof trigger.script === "string") {
      const migration = migrateLegacyCronTriggerScript(trigger.script);
      const id = normalizeOptionalString(raw.id);
      const name = normalizeOptionalString(raw.name);
      const jobIdentity = name && id && name !== id ? `${name} (${id})` : (name ?? id);
      if (migration.kind === "supported") {
        trigger.script = migration.script;
        mutated = true;
        if (jobIdentity) {
          legacyTriggerScriptJobs.push(jobIdentity);
        }
      } else if (migration.kind === "unsupported" && jobIdentity) {
        unsupportedLegacyTriggerScriptJobs.push(jobIdentity);
      }
    }

    setField(raw, "description", normalizeOptionalString(raw.description));

    if ("sessionKey" in raw) {
      setField(raw, "sessionKey", normalizeOptionalString(raw.sessionKey));
    }

    if (typeof raw.enabled !== "boolean") {
      setField(raw, "enabled", true);
    }

    setField(
      raw,
      "wakeMode",
      normalizeOptionalLowercaseString(raw.wakeMode) === "next-heartbeat"
        ? "next-heartbeat"
        : "now",
    );

    if (!isRecord(raw.payload) && inferPayloadIfMissing(raw)) {
      trackChange("legacyTopLevelPayloadFields");
    }

    const payloadRecord = asNullableRecord(raw.payload);

    if (payloadRecord) {
      if (normalizePayloadKind(payloadRecord)) {
        trackChange("legacyPayloadKind");
      }
      if (payloadRecord.kind === "agentTurn" && copyTopLevelAgentTurnFields(raw, payloadRecord)) {
        mutated = true;
      }
      if (payloadRecord.kind === "systemEvent" && !normalizeOptionalString(payloadRecord.text)) {
        const message = normalizeOptionalString(payloadRecord.message);
        if (message) {
          payloadRecord.text = message;
          delete payloadRecord.message;
          trackChange("legacyPayloadKind");
        }
      }
    }

    const removedTopLevel = stripLegacyTopLevelFields(raw);
    if (removedTopLevel.payload) {
      trackChange("legacyTopLevelPayloadFields");
    }
    if (removedTopLevel.delivery) {
      trackChange("legacyTopLevelDeliveryFields");
    }

    if (payloadRecord) {
      const hasLegacyGatewayExec =
        Array.isArray(payloadRecord.toolsAllow) &&
        payloadRecord.toolsAllow.some(
          (tool) =>
            typeof tool === "string" && normalizeOptionalLowercaseString(tool) === "gateway_exec",
        );
      if (hasLegacyGatewayExec) {
        const name = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
        if (name) {
          legacyGatewayExecJobs.push(name);
        }
      }
      const hadLegacyPayloadProvider = Boolean(normalizeOptionalString(payloadRecord.provider));
      const legacyCodexModelRoutes = collectLegacyOpenAICodexCronModelRoutes(payloadRecord);
      const hadLegacyPayloadCodexModel = legacyCodexModelRoutes.length > 0;
      const agentId = normalizeOptionalString(raw.agentId);
      const shouldMigrateCodexModelRef = (modelRef: string, legacyModelRef: string) =>
        options.shouldMigrateCodexRuntimePolicyTarget?.({
          ...(agentId ? { agentId } : {}),
          modelRef,
          legacyModelRef,
        }) !== false;
      if (hadLegacyPayloadCodexModel) {
        trackIssue("legacyPayloadCodexModel");
      }
      for (const [issue, migration] of [
        ["legacyTaskSuggestionToolName", TASK_SUGGESTION_TOOL_NAME_MIGRATION],
        ["legacyImageInspectionToolName", IMAGE_INSPECTION_TOOL_NAME_MIGRATION],
      ] as const) {
        if (hasLegacyToolNameList(payloadRecord.toolsAllow, migration)) {
          trackIssue(issue);
        }
      }
      if (
        migrateLegacyCronPayload(payloadRecord, {
          migrateCodexModelRefs: options.migrateCodexModelRefs,
          shouldMigrateCodexModelRef,
        })
      ) {
        mutated = true;
        if (hadLegacyPayloadProvider) {
          trackIssue("legacyPayloadProvider");
        }
      }
      if (hadLegacyPayloadCodexModel && options.migrateCodexModelRefs === true) {
        for (const route of legacyCodexModelRoutes) {
          const target = {
            ...(agentId ? { agentId } : {}),
            modelRef: route.canonicalModelRef,
            legacyModelRef: route.legacyModelRef,
          };
          if (shouldMigrateCodexModelRef(route.canonicalModelRef, route.legacyModelRef)) {
            codexRuntimePolicyTargets.set(cronCodexRuntimePolicyTargetKey(target), target);
          }
        }
      }
      if (migrateLegacyAgentTurnCommandPayload(payloadRecord)) {
        trackChange("legacyAgentTurnCommandPayload");
      } else {
        const unresolvedPromptKind = classifyCronAgentTurnShellPrompt(payloadRecord);
        if (unresolvedPromptKind) {
          trackIssue("unresolvedAgentTurnShellToolPrompt");
          const name = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
          if (name) {
            unresolvedAgentTurnPromptJobsByKind[unresolvedPromptKind].push(name);
          }
        }
      }
    }

    const sched = raw.schedule;
    if (isRecord(sched)) {
      const kind = normalizeOptionalLowercaseString(sched.kind) ?? "";
      const canonicalKind = ["at", "every", "cron", "on-exit", "stream"].includes(kind)
        ? kind
        : undefined;
      if (canonicalKind && sched.kind !== canonicalKind) {
        sched.kind = canonicalKind;
        trackChange("legacyScheduleKind");
      }
      if (canonicalKind === "stream") {
        const streamMode = normalizeOptionalLowercaseString(sched.mode);
        if ((streamMode === "line" || streamMode === "match") && sched.mode !== streamMode) {
          sched.mode = streamMode;
          trackChange("legacyScheduleKind");
        }
      }
      if (!kind && ("at" in sched || "atMs" in sched)) {
        sched.kind = "at";
        mutated = true;
      }
      const atMsRaw = sched.atMs;
      const parsedAtMs =
        typeof atMsRaw === "number"
          ? atMsRaw
          : typeof atMsRaw === "string"
            ? parseAbsoluteTimeMs(atMsRaw)
            : null;
      const normalizedAt =
        timestampMsToIsoString(parsedAtMs) ??
        timestampMsToIsoString(parseAbsoluteTimeMs(normalizeOptionalString(sched.at) ?? ""));
      if (normalizedAt && (sched.at !== normalizedAt || "atMs" in sched)) {
        sched.at = normalizedAt;
        delete sched.atMs;
        mutated = true;
      }

      const everyMsCoerced = coerceFiniteScheduleNumber(sched.everyMs);
      const everyMs = everyMsCoerced !== undefined ? Math.floor(everyMsCoerced) : null;
      if (everyMs !== null) {
        setField(sched, "everyMs", everyMs);
      }
      if (sched.kind === "every" && everyMs !== null) {
        const anchor =
          coerceFiniteScheduleNumber(sched.anchorMs) ??
          asFiniteNumber(raw.createdAtMs) ??
          asFiniteNumber(raw.updatedAtMs);
        if (anchor !== undefined) {
          setField(sched, "anchorMs", Math.max(0, Math.floor(anchor)));
        }
      }

      const exprRaw = normalizeOptionalString(sched.expr) ?? "";
      const normalizedExpr = exprRaw || normalizeOptionalString(sched.cron) || "";
      if (!exprRaw && normalizedExpr) {
        sched.expr = normalizedExpr;
        trackChange("legacyScheduleCron");
      }
      if (typeof sched.expr === "string") {
        setField(sched, "expr", normalizedExpr);
      }
      if ("cron" in sched) {
        delete sched.cron;
        trackChange("legacyScheduleCron");
      }
      if (sched.kind === "cron" && normalizedExpr) {
        const explicitStaggerMs = normalizeCronStaggerMs(sched.staggerMs);
        const defaultStaggerMs = resolveDefaultCronStaggerMs(normalizedExpr);
        const targetStaggerMs = explicitStaggerMs ?? defaultStaggerMs;
        if (targetStaggerMs === undefined) {
          if ("staggerMs" in sched) {
            delete sched.staggerMs;
            mutated = true;
          }
        } else {
          setField(sched, "staggerMs", targetStaggerMs);
        }
      }
    }

    const delivery = asNullableRecord(raw.delivery);
    if (delivery) {
      const mode = resolveLegacyCronDeliveryMode(delivery.mode);
      if (mode !== undefined && mode !== delivery.mode) {
        delivery.mode = mode;
        trackChange("legacyDeliveryMode");
      }
    }

    if (isRecord(raw.isolation)) {
      delete raw.isolation;
      mutated = true;
    }

    const payloadKind = payloadRecord?.kind;
    const isRunnablePayload =
      payloadKind === "agentTurn" || payloadKind === "command" || payloadKind === "script";
    const rawSessionTarget = normalizeOptionalString(raw.sessionTarget) ?? "";
    const loweredSessionTarget = normalizeLowercaseStringOrEmpty(rawSessionTarget);
    if (
      loweredSessionTarget === "main" ||
      loweredSessionTarget === "isolated" ||
      loweredSessionTarget === "current"
    ) {
      const sessionTarget = resolveCronCurrentSessionTarget({
        sessionTarget: loweredSessionTarget,
        sessionKey: normalizeOptionalString(raw.sessionKey),
      });
      setField(raw, "sessionTarget", sessionTarget);
    } else if (loweredSessionTarget.startsWith("session:")) {
      const customSessionId = rawSessionTarget.slice(8).trim();
      if (customSessionId) {
        setField(raw, "sessionTarget", `session:${customSessionId}`);
      }
    } else {
      setField(raw, "sessionTarget", isRunnablePayload ? "isolated" : "main");
    }

    const sessionTarget = normalizeOptionalLowercaseString(raw.sessionTarget) ?? "";
    const isIsolatedTarget =
      sessionTarget === "isolated" ||
      sessionTarget === "current" ||
      sessionTarget.startsWith("session:");
    const normalizedLegacy = normalizeLegacyDeliveryInput({
      delivery,
      payload: payloadRecord,
    });

    if (!delivery && isIsolatedTarget && isRunnablePayload) {
      raw.delivery = normalizedLegacy.delivery ?? { mode: "announce" };
      mutated = true;
    } else if (normalizedLegacy.mutated && normalizedLegacy.delivery) {
      raw.delivery = normalizedLegacy.delivery;
      mutated = true;
    }

    const policyMigration = migrateScheduledToolPolicy(raw);
    if (policyMigration.status === "migrated") {
      trackIssue("migratedScheduledToolPolicy");
    }
    if (policyMigration.ownerReconciled) {
      trackIssue("reconciledOwnerAccount");
    }
    const jobName = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
    if (jobName && policyMigration.status === "legacy") {
      legacyScheduledToolPolicyJobs.push(jobName);
    } else if (jobName && policyMigration.status === "invalid") {
      invalidScheduledToolPolicyJobs.push(jobName);
    }
    mutated ||= policyMigration.mutated;

    const invalidPersistedReason = getInvalidPersistedCronJobReason(raw);
    if (invalidPersistedReason) {
      if (
        invalidPersistedReason === "missing-schedule" ||
        invalidPersistedReason === "invalid-schedule"
      ) {
        trackIssue("invalidSchedule");
      } else if (
        invalidPersistedReason === "missing-payload" ||
        invalidPersistedReason === "invalid-payload"
      ) {
        trackIssue("invalidPayload");
      }
      removedJobs.push({ job: structuredClone(raw), reason: invalidPersistedReason, sourceIndex });
      mutated = true;
      continue;
    }
    keptJobs.push(raw);
  }

  if (keptJobs.length !== jobs.length) {
    jobs.splice(0, jobs.length, ...keptJobs);
  }

  return {
    codexRuntimePolicyTargets: [...codexRuntimePolicyTargets.values()],
    issues,
    unresolvedAgentTurnCommandPromptJobs,
    unresolvedAgentTurnShellToolPromptJobs,
    legacyTriggerScriptJobs,
    unsupportedLegacyTriggerScriptJobs,
    unsupportedDeliveryModeJobs,
    legacyScheduledToolPolicyJobs,
    invalidScheduledToolPolicyJobs,
    legacyGatewayExecJobs,
    jobs,
    mutated,
    removedJobs,
  };
}

export type QuarantinedCronJobRecovery = {
  recoveredJobs: Array<Record<string, unknown>>;
  recoveredEntries: Array<QuarantinedCronConfigJob | CronQuarantinedJob>;
  retainedEntries: Array<QuarantinedCronConfigJob | CronQuarantinedJob>;
};

function storedCronJobId(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalStringifiedId(job.id) ?? normalizeOptionalStringifiedId(job.jobId);
}

/** Revalidate quarantined schedule rows for an explicit Doctor repair. */
export function recoverValidQuarantinedCronScheduleJobs(
  entries: ReadonlyArray<QuarantinedCronConfigJob | CronQuarantinedJob>,
  activeJobIds: ReadonlySet<string>,
): QuarantinedCronJobRecovery {
  const recoveredJobs: Array<Record<string, unknown>> = [];
  const recoveredEntries: Array<QuarantinedCronConfigJob | CronQuarantinedJob> = [];
  const retainedEntries: Array<QuarantinedCronConfigJob | CronQuarantinedJob> = [];
  const recoveredJobIds = new Set<string>();

  for (const entry of entries) {
    if (entry.reason !== "invalid-schedule" || !isRecord(entry.job)) {
      retainedEntries.push(entry);
      continue;
    }
    const candidate = structuredClone(entry.job);
    const jobId = storedCronJobId(candidate);
    if (jobId && (activeJobIds.has(jobId) || recoveredJobIds.has(jobId))) {
      retainedEntries.push(entry);
      continue;
    }
    if (isRecord(entry.state)) {
      candidate.state = structuredClone(entry.state);
    }
    if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
      candidate.updatedAtMs = entry.updatedAtMs;
    }

    const normalized = normalizeStoredCronJobs([candidate]);
    if (normalized.jobs.length !== 1 || normalized.removedJobs.length !== 0) {
      retainedEntries.push(entry);
      continue;
    }
    recoveredJobs.push(candidate);
    recoveredEntries.push(entry);
    if (jobId) {
      recoveredJobIds.add(jobId);
    }
  }

  return { recoveredJobs, recoveredEntries, retainedEntries };
}
