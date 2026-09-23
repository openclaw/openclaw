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
import type {
  CronCompletionStatus,
  CronFailureNotificationDelivery,
  CronFailureNotificationDetail,
  CronJob,
  CronMessageChannel,
} from "../types.js";
import {
  cronNotificationJob,
  type CronNotificationJob,
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

function normalizeCronMessageChannel(input: unknown): CronMessageChannel | undefined {
  const channel = normalizeOptionalLowercaseString(input);
  return channel ? (channel as CronMessageChannel) : undefined;
}

function resolveFailureAlertChannel(channel: unknown, to?: string): CronMessageChannel | undefined {
  const normalized = normalizeCronMessageChannel(channel);
  if (normalized && normalized !== "last") {
    return normalizeAnyChannelId(normalized) ?? normalized;
  }
  return normalizeCronMessageChannel(resolveTargetPrefixedChannel(to)) ?? normalized;
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
    deps: Pick<CronJobPolicyContext["deps"], "cronConfig">;
    preparedFailureAlert?: CronJobPolicyContext["preparedFailureAlert"];
  },
  job: Pick<CronJob, "delivery" | "failureAlert"> & Partial<Pick<CronJob, "id">>,
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
  const primaryRoute = resolveCronDeliveryPlan(job);
  const primaryAnnounceRoute =
    primaryRoute.mode === "announce" && primaryRoute.requested ? primaryRoute : undefined;
  const explicitlyConfigured = jobConfig !== undefined || globalConfig !== undefined;
  if (!alternateRoute && !primaryAnnounceRoute && !explicitlyConfigured) {
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

function buildFailureAlertPayload(params: {
  job: CronNotificationJob;
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
  runAtMs?: number;
  consecutiveErrors: number;
  route: ResolvedFailureAlert;
  status: "error" | "skipped";
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
      : cronFailureDetailLines(errorReason, params.failureNotificationDetail);
  const text = [
    `Automation "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`,
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

function requestFailureNotification(
  state: CronJobPolicyContext,
  job: CronJob,
  alertConfig: ResolvedFailureAlert,
  incident: Required<FailureAlertIncident>,
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
  startFailureNotification(job);
  job.state.lastFailureAlertAtMs = now;
  job.state.failureAlertIncident = {
    ...incident,
    scope: job.state.failureAlertIncident?.scope === "run" ? "run" : incident.scope,
  };
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
}): Required<FailureAlertIncident> {
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

/** Emits one alert per incident when threshold, best-effort, and cooldown policy allow it. */
export function maybeEmitFailureAlert(
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
    deferredNotifications: DeferredCronNotifications;
  },
) {
  recordUnresolvedFailure(params.job, params.failureNotificationDetail);
  const alertConfig = params.alertConfig;
  if (!alertConfig || params.consecutiveCount < alertConfig.after) {
    return;
  }
  // Best-effort delivery suppresses inherited alert noise, not an independently
  // configured job alert that the operator explicitly requested.
  if (params.job.delivery?.bestEffort === true && !params.job.failureAlert) {
    return;
  }
  if (
    !requestFailureNotification(
      state,
      params.job,
      alertConfig,
      failureIncident({ ...params, route: alertConfig }),
    )
  ) {
    return;
  }

  const job = cronNotificationJob(params.job);
  params.deferredNotifications.push({
    kind: "failure-alert",
    job,
    payload: buildFailureAlertPayload({
      job,
      error: params.error,
      errorReason: params.errorReason,
      failureNotificationDetail: params.failureNotificationDetail,
      consecutiveErrors: params.consecutiveCount,
      route: alertConfig,
      status: params.status,
    }),
    runAtMs: params.runAtMs,
    route: alertConfig,
  });
}

/** Resolves incidents after execution succeeds, notifying only when a failure was reported. */
export function maybeEmitFailureRecovery(params: {
  job: CronJob;
  alertConfig: ResolvedFailureAlert | null;
  runAtMs?: number;
  triggerOnly?: boolean;
  replay?: boolean;
  deferredNotifications: DeferredCronNotifications;
}): void {
  const incident = params.job.state.failureAlertIncident;
  if (!incident || (params.triggerOnly && incident.scope !== "trigger")) {
    return;
  }
  delete params.job.state.failureAlertIncident;
  params.job.state.lastFailureAlertAtMs = undefined;
  const route = params.alertConfig;
  if (
    params.replay ||
    !incident.signature ||
    !route ||
    (params.job.delivery?.bestEffort === true && !params.job.failureAlert)
  ) {
    return;
  }
  startFailureNotification(params.job);
  const job = cronNotificationJob(params.job);
  const payload: ReplyPayload = {
    text: [
      `Automation "${job.name || job.id}" recovered`,
      params.triggerOnly
        ? "The trigger check completed successfully; no run was needed."
        : "The latest run completed successfully.",
    ].join("\n"),
  };
  params.deferredNotifications.push({
    kind: "failure-alert",
    job,
    payload,
    runAtMs: params.runAtMs,
    route,
  });
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
      startedAt: number;
    };
    completionStatus: CronCompletionStatus;
    autoDisableNotificationOwnsFailure: boolean;
    replay?: boolean;
    deferredNotifications: DeferredCronNotifications;
  },
): void {
  if (params.result.status === "ok" && params.completionStatus === "succeeded") {
    maybeEmitFailureRecovery({
      job: params.job,
      alertConfig: params.alertConfig,
      runAtMs: params.result.startedAt,
      replay: params.replay,
      deferredNotifications: params.deferredNotifications,
    });
    return;
  }
  recordUnresolvedFailure(params.job, params.result.failureNotificationDetail);
  // Replay repairs incident state but never requests a historical notification.
  if (params.replay) {
    return;
  }
  if (params.result.status === "error" && !params.autoDisableNotificationOwnsFailure) {
    maybeEmitFailureAlert(state, {
      job: params.job,
      alertConfig: params.alertConfig,
      status: "error",
      error: params.result.error,
      errorReason: params.job.state.lastErrorReason,
      failureNotificationDetail: params.result.failureNotificationDetail,
      runAtMs: params.result.startedAt,
      consecutiveCount: params.job.state.consecutiveErrors ?? 0,
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
      return;
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
}
