/** Resolves and emits cron failure-alert notifications. */
import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyOAuthRefreshFailure } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import { buildProviderLoginRecovery } from "../../auto-reply/provider-login-recovery.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeAnyChannelId } from "../../channels/registry-normalize.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import {
  resolveCronDeliveryDefaultsScope,
  resolveCronFailureAlertDefaults,
} from "../delivery-defaults.js";
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
  CronStoredJob,
} from "../types.js";
import { buildCronAutoDisableNotice, cronAutoDisableNotification } from "./auto-disable.js";
import {
  canStartCronFailureRepair,
  failedRunVerifiesCronRepair,
  hasFailureRepairOwner,
  startCronFailureRepair,
} from "./failure-repair.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import {
  cronNotificationJob,
  type CronNotificationIntent,
  type ResolvedFailureAlert,
} from "./notification-intents.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

const DEFAULT_FAILURE_ALERT_AFTER = 1;
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

/** Resolves effective failure-alert policy from job config, delivery defaults, and global cron config. */
export function resolveFailureAlert(
  state: {
    deps: Pick<
      CronJobPolicyContext["deps"],
      "cronConfig" | "defaultAgentId" | "resolveDefaultAgentId"
    >;
    preparedFailureAlert?: CronJobPolicyContext["preparedFailureAlert"];
  },
  job: Pick<CronJob, "delivery" | "failureAlert"> &
    Partial<
      Pick<
        CronJob,
        "id" | "owner" | "payload" | "schedule" | "agentId" | "sessionKey" | "sessionTarget"
      >
    > &
    Partial<Pick<CronStoredJob, "createdActor">>,
): ResolvedFailureAlert | null {
  const prepared = state.preparedFailureAlert;
  if (prepared) {
    if (prepared.jobId !== job.id) {
      throw new Error("cron: prepared failure-alert policy does not match the job");
    }
    return prepared.value;
  }
  const defaults = resolveCronDeliveryDefaultsScope(
    state.deps.cronConfig,
    job,
    state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
  );
  // The owner's agent route replaces the global route fields; tuning stays global.
  const globalConfig = resolveCronFailureAlertDefaults(defaults);
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
      jobConfig.threadId !== undefined ||
      jobConfig.mode !== undefined),
  );
  const alternateRoute = resolveFailureDestination(
    job,
    globalConfig,
    hasJobRoute ? jobConfig : undefined,
  );
  const primaryRoute = hasCanonicalCronDeliveryMode(job.delivery)
    ? resolveCronDeliveryPlan(job, defaults)
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
  // Preserve legacy thread inheritance when no explicit failure thread is set.
  const primaryThreadFallbackMatches =
    primaryRecipientMatches &&
    accountId === primaryAnnounceRoute?.accountId &&
    (alternateRoute === null ||
      !job.delivery?.failureDestination ||
      primaryAnnounceRoute?.threadId == null ||
      jobConfig?.to !== undefined);
  const threadId =
    mode === "announce"
      ? (normalizeOptionalThreadValue(route?.threadId) ??
        (primaryThreadFallbackMatches ? primaryAnnounceRoute?.threadId : undefined))
      : undefined;
  const primaryRouteMatches =
    primaryRecipientMatches &&
    accountId === primaryAnnounceRoute?.accountId &&
    normalizeOptionalStringifiedId(threadId) ===
      normalizeOptionalStringifiedId(primaryAnnounceRoute?.threadId);

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
    threadId,
    includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false,
    alternateRoute: alternateRoute !== null && !primaryRouteMatches,
  };
}

type FailureAlertIncident = NonNullable<CronJob["state"]["failureAlertIncident"]>;
/** One notification-worthy failure: its dedupe signature and recovery scope. */
type FailureAlertSignal = Required<FailureAlertIncident>;

function buildFailureAlertPayload(params: {
  job: CronJob;
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
  consecutiveErrors: number;
  route: ResolvedFailureAlert;
  status: "error" | "skipped";
  /** A run after the owner-conversation repair still failed. */
  escalation?: boolean;
  localProviderUnavailable?: boolean;
  /** The failure auto-disabled the recurring job: lead with the safety notice and recovery command. */
  autoDisabled?: boolean;
}) {
  const safeJobName = params.job.name || params.job.id;
  const errorReason = params.status === "error" ? params.errorReason : undefined;
  if (params.autoDisabled) {
    const notice = buildCronAutoDisableNotice({
      job: params.job,
      reason: "consecutive-failures",
      consecutiveErrors: params.consecutiveErrors,
    });
    return {
      text:
        params.route.mode === "webhook"
          ? `${notice}\nLast error: ${truncateUtf16Safe(params.error?.trim() || "unknown reason", 200)}`
          : notice,
    } satisfies ReplyPayload;
  }
  // Keep alert bodies compact because they may route through chat channels
  // with notification previews and provider-specific message limits.
  const statusVerb = params.status === "skipped" ? "was skipped" : "failed";
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
  const nextRunAtMs = isJobEnabled(params.job) ? params.job.state.nextRunAtMs : undefined;
  const nextRun =
    nextRunAtMs === undefined
      ? undefined
      : formatZonedTimestamp(new Date(nextRunAtMs), {
          timeZone: params.job.schedule.kind === "cron" ? params.job.schedule.tz : undefined,
          displayWeekday: true,
        });
  const text = [
    params.escalation
      ? `"${safeJobName}" is still failing after an automatic fix attempt.${nextRun ? ` Next run ${nextRun}.` : ""}`
      : `Automation "${safeJobName}" ${statusVerb}${params.consecutiveErrors > 1 ? ` ${params.consecutiveErrors} times in a row` : ""}.`,
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
 * A terminal failure or a failed repair verification is news on its own: it skips the
 * threshold and cooldown.
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
    runAtMs: number;
    consecutiveCount: number;
    terminalOneShot?: boolean;
    terminalRecurring?: boolean;
    escalation?: boolean;
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
  const route = availableFailureAlertRoute(params.job, params.alertConfig);
  if (!route) {
    return "unavailable";
  }
  const forced = params.terminalRecurring === true || params.escalation === true;
  if (!forced && params.terminalOneShot !== true && params.consecutiveCount < route.after) {
    return "suppressed";
  }
  const incident = failureIncident({ ...params, route });
  if (forced) {
    // The streak's earlier notification shares this incident signature; this one is still news.
    startFailureAlertCycle(params.job, incident, state.deps.nowMs());
  } else if (!requestFailureNotification(state, params.job, route, incident)) {
    return "suppressed";
  }
  params.deferredNotifications.push(
    buildFailureAlertNotification({ ...params, route, localProviderUnavailable }),
  );
  return "queued";
}

/**
 * Best-effort delivery suppresses inherited alert noise, not an independently configured job
 * alert that the operator explicitly requested.
 */
function availableFailureAlertRoute(job: CronJob, alertConfig: ResolvedFailureAlert | null) {
  return job.delivery?.bestEffort === true && !job.failureAlert ? null : alertConfig;
}

function buildFailureAlertNotification(params: {
  job: CronJob;
  route: ResolvedFailureAlert;
  status: "error" | "skipped";
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
  runAtMs: number;
  consecutiveCount: number;
  terminalRecurring?: boolean;
  escalation?: boolean;
  localProviderUnavailable?: boolean;
}): Extract<CronNotificationIntent, { kind: "failure-alert" }> {
  return {
    kind: "failure-alert",
    job: cronNotificationJob(params.job),
    payload: buildFailureAlertPayload({
      ...params,
      consecutiveErrors: params.consecutiveCount,
      autoDisabled: params.terminalRecurring,
    }),
    runAtMs: params.runAtMs,
    route: params.route,
  };
}

/**
 * Resolves the incident after execution succeeds. Recovery is visible in run history and
 * job state only: a working automation just works, so no notification is sent. Clearing
 * the incident, its repair, and the cooldown lets the next failure start over.
 */
export function resolveFailureIncident(job: CronJob, opts?: { triggerOnly?: boolean }): void {
  const incident = job.state.failureAlertIncident;
  if (!incident || (opts?.triggerOnly && incident.scope !== "trigger")) {
    return;
  }
  delete job.state.failureAlertIncident;
  delete job.state.failureRepair;
  job.state.lastFailureAlertAtMs = undefined;
}

/**
 * Finalizes failure notifications after scheduling policy settles. Order matters: a quick
 * provider retry holds everything; an auto-disable notice always goes out; an owned job's
 * first failure goes to its owner conversation; a failed run after that repair escalates
 * once; everything else follows the ordinary alert policy.
 */
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
    /** The recurring job was auto-disabled by this failure; the route carries its safety notice. */
    terminalRecurring?: boolean;
    terminalOneShot?: boolean;
    /** A quick re-run for a provider outage is scheduled; alert/repair wait for its outcome. */
    pendingTransientRetry?: boolean;
    replay?: boolean;
    deferredNotifications: DeferredCronNotifications;
  },
): ReturnType<typeof maybeEmitFailureAlert> | undefined {
  const { job, result } = params;
  if (result.status === "ok" && params.completionStatus === "succeeded") {
    resolveFailureIncident(job);
    return undefined;
  }
  if (result.errorClassification?.kind === "aborted") {
    return undefined;
  }
  recordUnresolvedFailure(job, result.failureNotificationDetail);
  // Replay repairs incident state but never requests a historical notification.
  if (params.replay) {
    return undefined;
  }
  if ((result.status === "error" || result.status === "skipped") && !params.pendingTransientRetry) {
    const alert = {
      job,
      alertConfig: params.alertConfig,
      status: result.status,
      error: result.error,
      errorReason: job.state.lastErrorReason,
      failureNotificationDetail: result.failureNotificationDetail,
      runAtMs: result.startedAt,
      consecutiveCount:
        (result.status === "skipped"
          ? job.state.consecutiveSkipped
          : job.state.consecutiveErrors) ?? 0,
      terminalOneShot: params.terminalOneShot,
      terminalRecurring: params.terminalRecurring,
      deferredNotifications: params.deferredNotifications,
    };
    const repair = job.state.failureRepair;
    if (result.status === "error" && !params.terminalRecurring) {
      if (!repair && canStartCronFailureRepair(job, params.terminalOneShot === true)) {
        // The cycle starts now so a fallback alert can record its outcome; none is sent yet.
        const route = availableFailureAlertRoute(job, params.alertConfig);
        if (route) {
          startFailureAlertCycle(job, failureIncident({ ...alert, route }), state.deps.nowMs());
        }
        startCronFailureRepair(state, {
          job,
          error: result.error,
          scope: failureRecoveryScope(result.failureNotificationDetail),
          terminalOneShot: params.terminalOneShot === true,
          // Without an alert route, a disabled one-shot still gets its in-app safety notice.
          fallback: route
            ? buildFailureAlertNotification({ ...alert, route })
            : params.terminalOneShot
              ? cronAutoDisableNotification({
                  job,
                  reason: "consecutive-failures",
                  consecutiveErrors: job.state.consecutiveErrors ?? 0,
                })
              : undefined,
          deferredNotifications: params.deferredNotifications,
        });
        return "queued";
      }
      if (repair && !repair.escalatedAtMs) {
        if (!failedRunVerifiesCronRepair(repair, result.startedAt)) {
          return "suppressed";
        }
        // Escalate once, even when no alert route exists; the Control UI shows it either way.
        repair.escalatedAtMs = state.deps.nowMs();
        return maybeEmitFailureAlert(state, { ...alert, escalation: true });
      }
    }
    return maybeEmitFailureAlert(state, alert);
  } else if (
    result.status === "ok" &&
    params.completionStatus === "failed" &&
    job.state.lastDeliveryStatus === "not-delivered" &&
    params.alertConfig?.alternateRoute
  ) {
    if (
      !requestFailureNotification(
        state,
        job,
        params.alertConfig,
        failureIncident({
          status: "delivery",
          error: job.state.lastDeliveryError,
          errorReason: job.state.lastErrorReason,
          route: params.alertConfig,
        }),
      )
    ) {
      return undefined;
    }
    const notice = cronNotificationJob(job);
    const route = params.alertConfig;
    const detailLines =
      route.mode === "webhook"
        ? [
            `Last error: ${truncateUtf16Safe(job.state.lastDeliveryError?.trim() || "unknown reason", 200)}`,
          ]
        : cronFailureDetailLines(job.state.lastErrorReason);
    const payload: ReplyPayload = {
      text: [`Automation "${notice.name || notice.id}" delivery failed`, ...detailLines].join("\n"),
    };
    params.deferredNotifications.push({
      kind: "failure-alert",
      job: notice,
      payload,
      runAtMs: result.startedAt,
      route,
    });
  }
  return undefined;
}
