/** Resolves and emits cron failure-alert notifications. */
import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyOAuthRefreshFailure } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import { buildProviderLoginRecovery } from "../../auto-reply/provider-login-recovery.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeAnyChannelId } from "../../channels/registry-normalize.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { cronFailureDetailLines } from "../failure-notification-text.js";
import { hasCanonicalCronDeliveryMode } from "../store/delivery-codec.js";
import type {
  CronCompletionStatus,
  CronFailureNotificationDelivery,
  CronFailureNotificationDetail,
  CronJob,
  CronMessageChannel,
  CronRunErrorClassification,
} from "../types.js";
import { buildCronFailureRepairBrief } from "./failure-repair-brief.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import {
  cronNotificationJob,
  type CronNotificationIntent,
  type ResolvedFailureAlert,
} from "./notification-intents.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000; // 1 hour

/** Returns the last failure-notification delivery trace persisted on a cron job. */
export function failureNotificationDeliveryFromJobState(
  job: CronJob,
): CronFailureNotificationDelivery | undefined {
  const status = job.state.lastFailureNotificationDeliveryStatus;
  if (!status || status === "not-requested") {
    return undefined;
  }
  return {
    delivered: job.state.lastFailureNotificationDelivered,
    status,
    error: job.state.lastFailureNotificationDeliveryError,
  };
}

function resolveFailureAlertChannel(channel: unknown, to?: string): CronMessageChannel | undefined {
  const normalized = normalizeOptionalLowercaseString(channel);
  if (normalized && normalized !== "last") {
    return normalizeAnyChannelId(normalized) ?? normalized;
  }
  return normalizeOptionalLowercaseString(resolveTargetPrefixedChannel(to)) ?? normalized;
}

function normalizeFailureAlertRecipient(channel: CronMessageChannel, to: string): string {
  try {
    return normalizeTargetForProvider(channel, to) ?? to;
  } catch {
    // Invalid loaded targets are distinct routes; they must not block run finalization.
    return to;
  }
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 0 ? floored : fallback;
}

function hasFailureRepairOwner(
  job: Partial<Pick<CronJob, "owner" | "payload" | "schedule">>,
): boolean {
  return Boolean(
    job.owner?.sessionKey?.trim() &&
    job.payload &&
    job.payload.kind !== "command" &&
    job.schedule &&
    job.schedule.kind !== "on-exit" &&
    job.schedule.kind !== "stream",
  );
}

/** Resolves effective failure-alert policy from job config, delivery defaults, and global cron config. */
export function resolveFailureAlert(
  state: {
    deps: Pick<CronJobPolicyContext["deps"], "cronConfig">;
    preparedFailureAlert?: CronJobPolicyContext["preparedFailureAlert"];
  },
  job: Pick<CronJob, "delivery" | "failureAlert"> &
    Partial<Pick<CronJob, "id" | "owner" | "payload" | "schedule">>,
): ResolvedFailureAlert | null {
  const prepared = state.preparedFailureAlert;
  if (prepared) {
    if (prepared.jobId !== job.id) {
      throw new Error("cron: prepared failure-alert policy does not match the job");
    }
    return prepared.value;
  }
  const globalConfig = state.deps.cronConfig?.failureAlert;
  const jobConfig = job.failureAlert === false ? undefined : job.failureAlert;

  if (job.failureAlert === false) {
    return null;
  }
  if (!jobConfig && globalConfig?.enabled === false) {
    return null;
  }
  const hasJobRoute = Boolean(
    jobConfig &&
    (jobConfig.channel !== undefined ||
      jobConfig.to !== undefined ||
      jobConfig.accountId !== undefined ||
      jobConfig.mode !== undefined),
  );
  const alternateRoute = resolveFailureDestination(
    job,
    globalConfig,
    hasJobRoute ? jobConfig : undefined,
  );
  const primaryRoute = hasCanonicalCronDeliveryMode(job.delivery)
    ? resolveCronDeliveryPlan(job)
    : undefined;
  const primaryAnnounceRoute =
    primaryRoute?.mode === "announce" && primaryRoute.requested ? primaryRoute : undefined;
  const explicitlyConfigured = jobConfig !== undefined || globalConfig !== undefined;
  // An owned one-shot has a conversation to notify even without an external route.
  const hasOneShotRepairRoute = job.schedule?.kind === "at" && hasFailureRepairOwner(job);
  if (!alternateRoute && !primaryAnnounceRoute && !explicitlyConfigured && !hasOneShotRepairRoute) {
    return null;
  }
  const configuredMode =
    jobConfig?.mode ?? (jobConfig?.channel ? "announce" : undefined) ?? globalConfig?.mode;
  const route =
    alternateRoute ??
    (configuredMode === "webhook" && explicitlyConfigured
      ? {
          mode: "webhook",
          to: normalizeOptionalString(jobConfig?.to ?? globalConfig?.to),
          accountId: normalizeOptionalString(jobConfig?.accountId ?? globalConfig?.accountId),
        }
      : primaryAnnounceRoute);
  const mode = (route?.mode ?? configuredMode) === "webhook" ? "webhook" : "announce";
  const primaryChannel = primaryAnnounceRoute
    ? (resolveFailureAlertChannel(primaryAnnounceRoute.channel, primaryAnnounceRoute.to) ?? "last")
    : undefined;
  const hasAnnounceRouteSelector =
    jobConfig?.channel !== undefined ||
    jobConfig?.to !== undefined ||
    job.delivery?.failureDestination?.channel !== undefined ||
    job.delivery?.failureDestination?.to !== undefined ||
    globalConfig?.channel !== undefined ||
    globalConfig?.to !== undefined;
  const channel =
    mode === "announce" && !hasAnnounceRouteSelector && primaryChannel
      ? primaryChannel
      : (resolveFailureAlertChannel(route?.channel, route?.to) ?? "last");
  const routeUsesPrimaryChannel =
    mode === "announce" && primaryAnnounceRoute !== undefined && channel === primaryChannel;
  const to =
    normalizeOptionalString(route?.to) ??
    (routeUsesPrimaryChannel ? primaryAnnounceRoute?.to : undefined);
  const primaryRecipientMatches =
    primaryAnnounceRoute !== undefined &&
    mode === "announce" &&
    channel === primaryChannel &&
    (to === primaryAnnounceRoute.to ||
      (to !== undefined &&
        primaryAnnounceRoute.to !== undefined &&
        normalizeFailureAlertRecipient(channel, to) ===
          normalizeFailureAlertRecipient(channel, primaryAnnounceRoute.to)));
  const accountId =
    normalizeOptionalString(route?.accountId) ??
    (primaryRecipientMatches ? primaryAnnounceRoute?.accountId : undefined);
  // A configured failure destination has no thread and stays distinct from a
  // threaded primary peer unless a job alert names its own recipient.
  const primaryRouteMatches =
    primaryRecipientMatches &&
    accountId === primaryAnnounceRoute?.accountId &&
    (alternateRoute === null ||
      !job.delivery?.failureDestination ||
      primaryAnnounceRoute?.threadId == null ||
      jobConfig?.to !== undefined);

  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel,
    to,
    mode,
    accountId,
    threadId: primaryRouteMatches ? primaryAnnounceRoute.threadId : undefined,
    includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false,
    alternateRoute: alternateRoute !== null && !primaryRouteMatches,
  };
}

type FailureAlertIncident = NonNullable<CronJob["state"]["failureAlertIncident"]>;
/** One notification-worthy failure: its dedupe signature and recovery scope. */
type FailureAlertSignal = Required<Omit<FailureAlertIncident, "repair">>;

function buildFailureAlertPayload(params: {
  job: CronJob;
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
  consecutiveErrors: number;
  route: ResolvedFailureAlert;
  status: "error" | "skipped";
  repairRequested?: boolean;
  localProviderUnavailable?: boolean;
}) {
  const safeJobName = params.job.name || params.job.id;
  const errorReason = params.status === "error" ? params.errorReason : undefined;
  // Keep alert bodies compact because they may route through chat channels
  // with notification previews and provider-specific message limits.
  const statusVerb = params.status === "skipped" ? "skipped" : "failed";
  const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
  const detailLines =
    params.route.mode === "webhook"
      ? [
          ...(errorReason ? [`Cause: ${errorReason}`] : []),
          `${detailLabel}: ${truncateUtf16Safe(params.error?.trim() || "unknown reason", 200)}`,
        ]
      : params.localProviderUnavailable
        ? [
            "Cause: the local model provider is unreachable.",
            "Start the provider or check its configured endpoint in automation history.",
            isJobEnabled(params.job) && params.job.state.nextRunAtMs !== undefined
              ? "OpenClaw will check again on a later scheduled run."
              : "After restoring the provider, use Run Now or reschedule this automation.",
          ]
        : cronFailureDetailLines(errorReason, params.failureNotificationDetail);
  const text = [
    `Automation "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`,
    ...(params.repairRequested
      ? ["An automatic repair was requested in its owner conversation; it is still failing."]
      : []),
    ...detailLines,
  ].join("\n");
  const oauthRefreshFailure = params.error ? classifyOAuthRefreshFailure(params.error) : null;
  const providerLoginRecovery =
    params.status === "error" && (errorReason === "auth" || errorReason === "auth_permanent")
      ? buildProviderLoginRecovery({
          provider: normalizeOptionalString(oauthRefreshFailure?.provider),
          oauthReason: oauthRefreshFailure?.reason,
        })
      : undefined;
  const payload: ReplyPayload = {
    text: providerLoginRecovery ? `${text}\n${providerLoginRecovery.hint}` : text,
    ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
  };

  return payload;
}

function startFailureNotification(job: CronJob): void {
  job.state.lastFailureNotificationId = randomUUID();
  job.state.lastFailureNotificationDelivered = undefined;
  job.state.lastFailureNotificationDeliveryStatus = "unknown";
  job.state.lastFailureNotificationDeliveryError = undefined;
}

function startFailureAlertCycle(job: CronJob, incident: FailureAlertSignal, now: number): void {
  startFailureNotification(job);
  job.state.lastFailureAlertAtMs = now;
  const current = job.state.failureAlertIncident;
  job.state.failureAlertIncident = {
    ...incident,
    scope: current?.scope === "run" ? "run" : incident.scope,
    // An alert after the repair request is its fallback; the marker lasts until success.
    ...(current?.repair ? { repair: { atMs: current.repair.atMs, alerted: true } } : {}),
  };
}

function requestFailureNotification(
  state: CronJobPolicyContext,
  job: CronJob,
  alertConfig: ResolvedFailureAlert,
  incident: FailureAlertSignal,
): boolean {
  if (job.state.failureAlertIncident?.signature === incident.signature) {
    return false;
  }
  const now = state.deps.nowMs();
  const lastAlert = job.state.lastFailureAlertAtMs;
  // Cooldown is stored on job state so process restarts and service reloads do
  // not spam operators. Future timestamps cannot prove a recent prior alert.
  const inCooldown =
    typeof lastAlert === "number" &&
    lastAlert <= now &&
    now - lastAlert < Math.max(0, alertConfig.cooldownMs);
  if (inCooldown) {
    return false;
  }
  startFailureAlertCycle(job, incident, now);
  return true;
}

function failureRecoveryScope(
  detail?: CronFailureNotificationDetail,
): FailureAlertIncident["scope"] {
  return detail?.kind === "script-failure" && detail.source === "trigger" ? "trigger" : "run";
}

function recordUnresolvedFailure(job: CronJob, detail?: CronFailureNotificationDetail): void {
  const scope = failureRecoveryScope(detail);
  const incident = (job.state.failureAlertIncident ??= { scope });
  if (scope === "run") {
    incident.scope = "run";
  }
}

function failureIncident(params: {
  status: "error" | "skipped" | "delivery";
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
  route: ResolvedFailureAlert;
}): FailureAlertSignal {
  // Classified causes ignore changing provider prose; unknown errors stay private.
  const cause = params.errorReason ?? params.failureNotificationDetail ?? params.error?.trim();
  const scope = failureRecoveryScope(params.failureNotificationDetail);
  return {
    signature: sha256Hex(
      JSON.stringify([
        params.status,
        scope,
        cause,
        params.route.mode,
        params.route.channel,
        params.route.to,
        params.route.accountId,
        params.route.threadId,
      ]),
    ),
    scope,
  };
}

/**
 * Emits one alert per incident when threshold, best-effort, and cooldown policy allow it.
 * An owned job's first chat alert, or terminal one-shot failure, becomes a repair request.
 * A later failure alerts, naming the request, and the streak is never repaired twice.
 */
function maybeEmitFailureAlert(
  state: CronJobPolicyContext,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    status: "error" | "skipped";
    error?: string;
    errorReason?: FailoverReason;
    failureNotificationDetail?: CronFailureNotificationDetail;
    runAtMs?: number;
    consecutiveCount: number;
    terminalOneShot?: boolean;
    deferredNotifications: DeferredCronNotifications;
  },
): "unavailable" | "suppressed" | "queued" {
  const localProviderUnavailable =
    params.status === "skipped" &&
    params.job.state.lastDiagnostics?.entries.some((entry) => entry.source === "model-preflight");
  if (
    params.status === "skipped" &&
    !params.alertConfig?.includeSkipped &&
    !localProviderUnavailable
  ) {
    return "suppressed";
  }
  recordUnresolvedFailure(params.job, params.failureNotificationDetail);
  const terminalOneShot = params.terminalOneShot === true;
  const alertConfig = params.alertConfig;
  if (!alertConfig) {
    return "unavailable";
  }
  if (!terminalOneShot && params.consecutiveCount < alertConfig.after) {
    return "suppressed";
  }
  // Best-effort delivery suppresses inherited alert noise, not an independently
  // configured job alert that the operator explicitly requested.
  if (params.job.delivery?.bestEffort === true && !params.job.failureAlert) {
    return "unavailable";
  }
  const incident = failureIncident({ ...params, route: alertConfig });
  const now = state.deps.nowMs();
  const repair = params.job.state.failureAlertIncident?.repair;
  // The repair request took this streak's alert and cooldown slot; if the job still
  // fails, the user gets that alert once.
  if (repair && !repair.alerted) {
    startFailureAlertCycle(params.job, incident, now);
  } else if (!requestFailureNotification(state, params.job, alertConfig, incident)) {
    return "suppressed";
  }
  const job = cronNotificationJob(params.job);
  const alert: Extract<CronNotificationIntent, { kind: "failure-alert" }> = {
    kind: "failure-alert",
    job,
    payload: buildFailureAlertPayload({
      job: params.job,
      error: params.error,
      errorReason: params.errorReason,
      failureNotificationDetail: params.failureNotificationDetail,
      consecutiveErrors: params.consecutiveCount,
      route: alertConfig,
      status: params.status,
      repairRequested: repair !== undefined,
      localProviderUnavailable,
    }),
    runAtMs: params.runAtMs,
    route: alertConfig,
  };
  if (
    !repair &&
    (terminalOneShot || alertConfig.mode === "announce") &&
    params.status === "error" &&
    // Command jobs and on-exit or stream schedules are operator-only, so they alert as before.
    hasFailureRepairOwner(params.job) &&
    (terminalOneShot || isJobEnabled(params.job))
  ) {
    const opened = params.job.state.failureAlertIncident ?? incident;
    params.job.state.failureAlertIncident = { ...opened, repair: { atMs: now } };
    // A terminal job keeps its alert cycle open for fallback delivery if repair cannot start.
    params.job.state.lastFailureNotificationDeliveryStatus = terminalOneShot
      ? "unknown"
      : "not-requested";
    params.deferredNotifications.push({
      kind: "failure-repair",
      job,
      ...(terminalOneShot ? { fallback: alert } : {}),
      text: buildCronFailureRepairBrief({
        job: params.job,
        consecutiveErrors: params.consecutiveCount,
        error: params.error,
        errorReason: params.errorReason,
        terminal: terminalOneShot,
      }),
    });
    return "queued";
  }
  params.deferredNotifications.push(alert);
  return "queued";
}

/**
 * Resolves the incident after execution succeeds. Recovery is visible in run history and
 * job state only: a working automation just works, so no notification is sent. Clearing
 * the incident and cooldown lets the next failure alert again.
 */
export function resolveFailureIncident(job: CronJob, opts?: { triggerOnly?: boolean }): void {
  const incident = job.state.failureAlertIncident;
  if (!incident || (opts?.triggerOnly && incident.scope !== "trigger")) {
    return;
  }
  delete job.state.failureAlertIncident;
  job.state.lastFailureAlertAtMs = undefined;
}

/** Finalizes execution or required-delivery alerts after scheduling policy settles. */
export function finalizeCronFailureNotifications(
  state: CronJobPolicyContext,
  params: {
    job: CronJob;
    alertConfig: ResolvedFailureAlert | null;
    result: {
      status: "ok" | "error" | "skipped";
      error?: string;
      failureNotificationDetail?: CronFailureNotificationDetail;
      errorClassification?: CronRunErrorClassification;
      startedAt: number;
    };
    completionStatus: CronCompletionStatus;
    autoDisableNotificationOwnsFailure: boolean;
    terminalOneShot?: boolean;
    /** A quick re-run for a provider outage is scheduled; alert/repair wait for its outcome. */
    pendingTransientRetry?: boolean;
    replay?: boolean;
    deferredNotifications: DeferredCronNotifications;
  },
): ReturnType<typeof maybeEmitFailureAlert> | undefined {
  if (params.result.status === "ok" && params.completionStatus === "succeeded") {
    resolveFailureIncident(params.job);
    return undefined;
  }
  if (
    params.result.errorClassification?.kind === "aborted" &&
    (params.job.schedule.kind === "at" || params.job.schedule.kind === "on-exit")
  ) {
    return undefined;
  }
  recordUnresolvedFailure(params.job, params.result.failureNotificationDetail);
  // Replay repairs incident state but never requests a historical notification.
  if (params.replay) {
    return undefined;
  }
  if (
    (params.result.status === "error" || params.result.status === "skipped") &&
    !params.autoDisableNotificationOwnsFailure &&
    !params.pendingTransientRetry
  ) {
    return maybeEmitFailureAlert(state, {
      job: params.job,
      alertConfig: params.alertConfig,
      status: params.result.status,
      error: params.result.error,
      errorReason: params.job.state.lastErrorReason,
      failureNotificationDetail: params.result.failureNotificationDetail,
      runAtMs: params.result.startedAt,
      consecutiveCount:
        (params.result.status === "skipped"
          ? params.job.state.consecutiveSkipped
          : params.job.state.consecutiveErrors) ?? 0,
      terminalOneShot: params.terminalOneShot,
      deferredNotifications: params.deferredNotifications,
    });
  } else if (
    params.result.status === "ok" &&
    params.completionStatus === "failed" &&
    params.job.state.lastDeliveryStatus === "not-delivered" &&
    params.alertConfig?.alternateRoute
  ) {
    if (
      !requestFailureNotification(
        state,
        params.job,
        params.alertConfig,
        failureIncident({
          status: "delivery",
          error: params.job.state.lastDeliveryError,
          errorReason: params.job.state.lastErrorReason,
          route: params.alertConfig,
        }),
      )
    ) {
      return undefined;
    }
    const job = cronNotificationJob(params.job);
    const route = params.alertConfig;
    const detailLines =
      route.mode === "webhook"
        ? [
            `Last error: ${truncateUtf16Safe(params.job.state.lastDeliveryError?.trim() || "unknown reason", 200)}`,
          ]
        : cronFailureDetailLines(params.job.state.lastErrorReason);
    const payload: ReplyPayload = {
      text: [`Automation "${job.name || job.id}" delivery failed`, ...detailLines].join("\n"),
    };
    params.deferredNotifications.push({
      kind: "failure-alert",
      job,
      payload,
      runAtMs: params.result.startedAt,
      route,
    });
  }
  return undefined;
}
