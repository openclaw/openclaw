// Sends announce and webhook notifications for cron completion/failure events.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../agents/date-time.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronAgentSelectionRequiredError } from "../cron/agent-id.js";
import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { retryTransientDirectCronDelivery } from "../cron/isolated-agent/delivery-dispatch-policy.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import { createCronExecutionId } from "../cron/run-id.js";
import type { CronEvent, CronService } from "../cron/service.js";
import type { CronFailureRepairRequest, CronServiceDeps } from "../cron/service/state.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type {
  CronFailureNotificationDelivery,
  CronJob,
  CronWebhookDeliveryOutcome,
} from "../cron/types.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { isProvenDeliveryNotSentError } from "../infra/delivery-recovery.shared.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
import { withTimeout } from "../infra/fs-safe.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError, type SsrFPolicy } from "../infra/net/ssrf.js";
import {
  runWithGatewayDetachedWorkContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../process/gateway-work-admission.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { waitForAgentJob } from "./agent-turn/agent-job.js";
import type { GatewayContextResolver } from "./server-methods/shared-types.js";
import { dispatchGatewayLifecycleMethod } from "./server-recovery-runtime-context.js";

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

type CronLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

type CronAgentResolver = (requested?: string | null) => {
  agentId: string;
  cfg: OpenClawConfig;
};

type CronFailureAlertParams = Parameters<
  NonNullable<ConstructorParameters<typeof CronService>[0]["sendCronFailureAlert"]>
>[0] & {
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
};

type GatewayCronFailureRepairDeps = {
  failureRepairTimeoutMs: NonNullable<CronServiceDeps["failureRepairTimeoutMs"]>;
  runCronFailureRepair: NonNullable<CronServiceDeps["runCronFailureRepair"]>;
};

/** Keeps the scheduler's persisted deadline and the repair turn's timeout identical. */
export function createGatewayCronFailureRepair(
  cfg: OpenClawConfig,
  resolveGatewayContext: GatewayContextResolver | undefined,
): GatewayCronFailureRepairDeps {
  return {
    failureRepairTimeoutMs: resolveAgentTimeoutMs({ cfg }),
    runCronFailureRepair: (request) => runGatewayCronFailureRepair(request, resolveGatewayContext),
  };
}

/**
 * The owner conversation receives the repair request as an ordinary turn: its own session,
 * workspace, and tool policy, with the reply delivered to its last route (thread included).
 * Only its authored reply reaches the chat: runtime failure payloads (timeouts, provider
 * errors) are not posted, and the job's next failure alert owns escalation.
 */
async function runGatewayCronFailureRepair(
  request: CronFailureRepairRequest,
  resolveGatewayContext: GatewayContextResolver | undefined,
): Promise<void> {
  const runId = `cron-failure-repair:${request.repairId}`;
  const deadlineAtMs = performance.now() + request.timeoutMs;
  // The cron run may retire its async scope before this independent repair settles.
  await runWithGatewayDetachedWorkContinuation(async () => {
    await dispatchGatewayLifecycleMethod(
      {
        ...(request.agentId ? { agentId: request.agentId } : {}),
        sessionKey: request.sessionKey,
        message: request.message,
        timeout: Math.ceil(request.timeoutMs / 1000),
        deliver: true,
        bestEffortDeliver: true,
        inputProvenance: {
          kind: "internal_system",
          sourceTool: "cron_failure_repair",
          jobId: request.jobId,
        },
        idempotencyKey: runId,
      },
      {
        // The scheduler's repair brief permits silence; public provenance does not grant it.
        replyExpectation: "optional",
        internalDeliverySuppressErrors: true,
        timeoutMs: request.timeoutMs,
        ...(resolveGatewayContext ? { resolveGatewayContext } : {}),
      },
    );
    const settled = await waitForAgentJob({
      runId,
      source: "agent",
      timeoutMs: Math.max(0, deadlineAtMs - performance.now()),
    });
    if (!settled || settled.timeoutPhase === "gateway_draining") {
      throw new Error("Cron failure repair did not settle before its agent timeout or shutdown.");
    }
  }, "cron:failure-repair");
}

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

function redactOptionalWebhookUrl(url: unknown): string | undefined {
  const normalized = normalizeOptionalString(url);
  return normalized ? redactWebhookUrl(normalized) : undefined;
}

function redactCommandCronEventForExternalDelivery(evt: CronEvent, job?: CronJob): CronEvent {
  if (job?.payload.kind !== "command") {
    return evt;
  }
  const summary = redactCronCommandSummaryForExternalDelivery(evt.summary);
  const diagnosticsSummary = redactCronCommandSummaryForExternalDelivery(evt.diagnostics?.summary);
  const diagnosticsEntries = evt.diagnostics?.entries.map((entry) => ({
    ...entry,
    message: redactCronCommandSummaryForExternalDelivery(entry.message) ?? entry.message,
  }));
  const diagnosticsEntriesChanged = diagnosticsEntries?.some(
    (entry, index) => entry.message !== evt.diagnostics?.entries[index]?.message,
  );
  const embeddedJobState = evt.job?.state;
  const stripEmbeddedJobDiagnostics = Boolean(
    embeddedJobState &&
    ("lastDiagnostics" in embeddedJobState || "lastDiagnosticSummary" in embeddedJobState),
  );
  if (
    summary === evt.summary &&
    diagnosticsSummary === evt.diagnostics?.summary &&
    !diagnosticsEntriesChanged &&
    !stripEmbeddedJobDiagnostics
  ) {
    return evt;
  }
  const redacted: CronEvent = { ...evt };
  if (summary !== undefined) {
    redacted.summary = summary;
  } else {
    delete redacted.summary;
  }
  if (evt.diagnostics) {
    redacted.diagnostics = { ...evt.diagnostics };
    if (diagnosticsSummary !== undefined) {
      redacted.diagnostics.summary = diagnosticsSummary;
    } else {
      delete redacted.diagnostics.summary;
    }
    if (diagnosticsEntries) {
      redacted.diagnostics.entries = diagnosticsEntries;
    }
  }
  if (stripEmbeddedJobDiagnostics && evt.job) {
    const state = { ...evt.job.state };
    delete state.lastDiagnostics;
    delete state.lastDiagnosticSummary;
    redacted.job = {
      ...evt.job,
      state,
    };
  }
  return redacted;
}

function resolveCronCompletionWebhook(delivery: CronJob["delivery"]): string | undefined {
  if (
    normalizeOptionalLowercaseString(delivery?.mode) !== "announce" ||
    normalizeOptionalLowercaseString(delivery?.completionDestination?.mode) !== "webhook"
  ) {
    return undefined;
  }
  return normalizeHttpWebhookUrl(delivery?.completionDestination?.to) ?? undefined;
}

function appendCronFailureAlertDetails(
  message: string,
  runAtMs: number | undefined,
  config: OpenClawConfig,
): string {
  let text = message;
  if (typeof runAtMs === "number" && Number.isFinite(runAtMs)) {
    const timestamp = formatZonedTimestamp(new Date(runAtMs), {
      timeZone: resolveUserTimezone(config.agents?.defaults?.userTimezone),
    });
    if (timestamp) {
      text += `\nRun started: ${timestamp}`;
    }
  }
  return text;
}

function buildCronFinishedWebhookPayload(evt: CronEvent) {
  if (evt.status !== "error") {
    return evt;
  }
  const { summary: _summary, diagnostics: _diagnostics, ...payload } = evt;
  if (evt.job) {
    const state = { ...evt.job.state };
    delete state.lastDiagnostics;
    delete state.lastDiagnosticSummary;
    return {
      ...payload,
      job: {
        ...evt.job,
        state,
      },
    };
  }
  return payload;
}

async function postCronWebhookStrict(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  onDeliveryState?: (outcome: CronWebhookDeliveryOutcome) => void;
  assertCurrent?: () => void;
}): Promise<void> {
  const remainingMs =
    params.deadlineAtMs === undefined ? CRON_WEBHOOK_TIMEOUT_MS : params.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    const error = new Error("cron webhook delivery deadline exceeded");
    error.name = "TimeoutError";
    throw error;
  }
  const requestTimeoutMs = Math.min(CRON_WEBHOOK_TIMEOUT_MS, remainingMs);
  const requestDeadlineAtMs = Date.now() + requestTimeoutMs;
  assertSecretOwnerAvailable("capability", "cron-webhook");
  let receivedResponse = false;
  const result = await fetchWithSsrFGuard({
    url: params.webhookUrl,
    timeoutMs: requestTimeoutMs,
    policy: params.ssrfPolicy,
    beforeRequest: () => {
      params.assertCurrent?.();
      params.onDeliveryState?.({ status: "unknown" });
    },
    onResponse: () => {
      receivedResponse = true;
    },
    ...(params.signal ? { signal: params.signal } : {}),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.webhookToken ? { Authorization: `Bearer ${params.webhookToken}` } : {}),
      },
      body: JSON.stringify(params.payload),
    },
  }).catch((error: unknown) => {
    // A connect error after a redirect does not disprove the earlier POST.
    if (params.onDeliveryState && !receivedResponse && isProvenDeliveryNotSentError(error)) {
      params.onDeliveryState({ status: "not-delivered", error: formatErrorMessage(error) });
    }
    throw error;
  });
  let accepted = false;
  try {
    if (!result.response.ok) {
      const error = new Error(`Webhook request failed with HTTP ${result.response.status}`);
      params.onDeliveryState?.({ status: "not-delivered", error: error.message });
      throw error;
    }
    accepted = true;
    params.onDeliveryState?.({ status: "delivered" });
  } finally {
    const cleanup = async () => {
      // Keep response cleanup before guard release inside the request deadline; a non-settling
      // stream cancellation must not retain the dispatcher or Gateway root.
      if (!result.response.bodyUsed) {
        const cancellation = result.response.body?.cancel();
        if (cancellation) {
          await withTimeout(
            cancellation,
            Math.max(1, requestDeadlineAtMs - Date.now()),
            "cron webhook response cleanup",
          ).catch(() => undefined);
        }
      }
      await result.release();
    };
    if (accepted) {
      // A 2xx acknowledgement is the terminal delivery fact. Cleanup must not
      // rewrite it after the receiver has accepted the webhook.
      await cleanup().catch(() => undefined);
    } else {
      await cleanup();
    }
  }
}

/** Posts a detached cron webhook without throwing back into scheduler completion flow. */
async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  ssrfPolicy?: SsrFPolicy;
  jobId: string;
  logger: CronLogger;
}): Promise<void> {
  try {
    await postCronWebhookStrict(params);
  } catch (err) {
    const blocked = err instanceof SsrFBlockedError;
    params.logger.warn(
      {
        jobId: params.jobId,
        source: "completionDestination",
        [blocked ? "reason" : "err"]: formatErrorMessage(err),
        webhookUrl: redactWebhookUrl(params.webhookUrl),
      },
      blocked ? "cron: webhook delivery blocked by SSRF guard" : "cron: webhook delivery failed",
    );
  }
}

/** Delivers the primary webhook while the cron run still owns its terminal outcome. */
export async function sendGatewayCronWebhook(params: {
  event: CronEvent;
  job: CronJob;
  abortSignal?: AbortSignal;
  deadlineAtMs?: number;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
  onDeliveryState?: (outcome: CronWebhookDeliveryOutcome) => void;
  assertCurrent?: () => void;
}): Promise<CronWebhookDeliveryOutcome> {
  let outcome: CronWebhookDeliveryOutcome = { status: "not-delivered" };
  const publish = (next: CronWebhookDeliveryOutcome) => {
    outcome = next;
    params.onDeliveryState?.(next);
  };
  try {
    const deliveryPlan = resolveCronDeliveryPlan(params.job);
    const webhookUrl = normalizeHttpWebhookUrl(deliveryPlan.to);
    if (!webhookUrl) {
      throw new Error("cron webhook delivery.to must be a valid http(s) URL");
    }
    const event = redactCommandCronEventForExternalDelivery(params.event, params.job);
    await retryTransientDirectCronDelivery({
      jobId: params.job.id,
      label: "webhook",
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      ...(params.deadlineAtMs !== undefined ? { deadlineAtMs: params.deadlineAtMs } : {}),
      run: () =>
        postCronWebhookStrict({
          webhookUrl,
          webhookToken: normalizeOptionalString(params.webhookToken),
          ssrfPolicy: params.ssrfPolicy,
          payload: buildCronFinishedWebhookPayload(event),
          signal: params.abortSignal,
          deadlineAtMs: params.deadlineAtMs,
          onDeliveryState: publish,
          assertCurrent: params.assertCurrent,
        }),
      shouldRetryError: (error) =>
        outcome.status === "not-delivered" && !(error instanceof SsrFBlockedError),
    });
    return outcome;
  } catch (error) {
    // Keep an HTTP acknowledgement/rejection even if cleanup fails afterward.
    if (outcome.status !== "delivered" && !outcome.error) {
      publish({ ...outcome, error: formatErrorMessage(error) });
    }
    return outcome;
  }
}

/** Transports a scheduler-authorized cron failure alert. */
export async function sendGatewayCronFailureAlert(params: CronFailureAlertParams): Promise<void> {
  let enteredAdmission = false;
  await runWithGatewayIndependentRootWorkContinuation(async () => {
    enteredAdmission = true;
    const settled = await sendGatewayCronFailureAlertUnderAdmission(params);
    await params.onDeliverySettled(settled.outcome);
    if (settled.kind === "failed") {
      throw settled.error;
    }
  }, "cron:failure-alert").catch(async (error: unknown) => {
    // Refused admission proves no send ran; admitted transports own their outcomes.
    if (!enteredAdmission) {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: formatErrorMessage(error),
      });
    }
    throw error;
  });
}

type FailureAlertTransportResult =
  | { kind: "settled"; outcome: CronFailureNotificationDelivery }
  | { kind: "failed"; error: unknown; outcome: CronFailureNotificationDelivery };

async function sendGatewayCronFailureAlertUnderAdmission(
  params: CronFailureAlertParams,
): Promise<FailureAlertTransportResult> {
  let mayHaveReachedRecipient = false;
  const onDeliveryAttempt = (reachedRecipient: boolean) => {
    mayHaveReachedRecipient ||= reachedRecipient;
  };
  try {
    const requestedAgentId =
      normalizeOptionalString(params.job.agentId) ??
      normalizeOptionalString(params.routing.defaultAgentId);
    if (!requestedAgentId) {
      throw new CronAgentSelectionRequiredError();
    }
    const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(requestedAgentId);
    if (params.mode === "webhook") {
      if (!params.to) {
        throw new Error("cron failure alert webhook requires a URL");
      }
      const webhookUrl = normalizeHttpWebhookUrl(params.to);
      if (!webhookUrl) {
        throw new Error("cron failure alert webhook requires a valid http(s) URL");
      }
      await postCronWebhookStrict({
        webhookUrl,
        webhookToken: normalizeOptionalString(params.webhookToken),
        ssrfPolicy: params.ssrfPolicy,
        onDeliveryState: (outcome) => {
          mayHaveReachedRecipient = outcome.status !== "not-delivered";
        },
        payload: {
          jobId: params.job.id,
          jobName: params.job.name,
          message: params.payload.text ?? "",
          runAtMs: params.runAtMs,
        },
      });
      return { kind: "settled", outcome: { delivered: true, status: "delivered" } };
    }

    const abortController = new AbortController();
    const deliveryTimeoutError = new Error("cron: failure alert announcement timed out");
    // Release Gateway admission on deadline even when a transport ignores abort.
    const result = await withTimeout(
      (async () => {
        const resolved = await resolveDeliveryTarget(
          runtimeConfig,
          agentId,
          {
            channel: params.channel,
            to: params.to,
            accountId: params.accountId,
            threadId: params.threadId,
            sessionKey: resolveCronDeliverySessionKey(params.job),
          },
          { inheritSessionThread: params.inheritSessionThread },
        );
        if (!resolved.ok) {
          throw resolved.error;
        }
        return await sendCronAnnouncePayloadStrict({
          deps: params.deps,
          cfg: runtimeConfig,
          agentId,
          jobId: params.job.id,
          target: resolved,
          transcriptRoute: resolved.sessionRoute,
          onTranscriptDiagnostic: (message) => {
            params.logger.warn({ jobId: params.job.id }, message);
          },
          payload: {
            ...params.payload,
            text: appendCronFailureAlertDetails(
              params.payload.text ?? "",
              params.runAtMs,
              runtimeConfig,
            ),
          },
          inspectionUrl: resolveControlUiAutomationRunUrl(runtimeConfig, {
            jobId: params.job.id,
            runId:
              params.runAtMs === undefined
                ? undefined
                : createCronExecutionId(params.job.id, params.runAtMs),
          }),
          abortSignal: abortController.signal,
          onDeliveryAttempt,
        });
      })(),
      CRON_WEBHOOK_TIMEOUT_MS,
      {
        createError: () => {
          abortController.abort(deliveryTimeoutError);
          return deliveryTimeoutError;
        },
      },
    );
    if (result.status === "sent") {
      return { kind: "settled", outcome: { delivered: true, status: "delivered" } };
    }
    const uncertain = result.reason === "adapter_returned_no_identity";
    return {
      kind: "settled",
      outcome: {
        delivered: uncertain ? undefined : false,
        status: uncertain ? "unknown" : "not-delivered",
        error: `cron failure alert ${uncertain ? "outcome is unknown" : "was suppressed"}: ${result.reason}`,
      },
    };
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      kind: "failed",
      error: err,
      outcome: {
        delivered: mayHaveReachedRecipient ? undefined : false,
        status: mayHaveReachedRecipient ? "unknown" : "not-delivered",
        error,
      },
    };
  }
}

/** Fans out completion webhooks after a cron run finishes. */
export function dispatchGatewayCronFinishedNotifications(params: {
  evt: CronEvent;
  job?: CronJob;
  logger: CronLogger;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
}): void {
  const webhookToken = normalizeOptionalString(params.webhookToken);
  const redactedWebhookEvent = redactCommandCronEventForExternalDelivery(params.evt, params.job);
  const completionSummary =
    params.job?.payload.kind === "script"
      ? normalizeOptionalString(redactedWebhookEvent.summary)
      : params.evt.summary;
  const completionWebhookUrl = resolveCronCompletionWebhook(params.job?.delivery);

  if (
    params.job?.delivery?.completionDestination?.mode === "webhook" &&
    !normalizeHttpWebhookUrl(params.job.delivery.completionDestination.to)
  ) {
    params.logger.warn(
      {
        jobId: params.evt.jobId,
        deliveryTo: redactOptionalWebhookUrl(params.job.delivery.completionDestination.to),
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  }

  // Script notify is carried as the prepared completion summary.
  if (completionWebhookUrl && (completionSummary || params.evt.completionStatus === "failed")) {
    const payload = buildCronFinishedWebhookPayload(redactedWebhookEvent);
    // Detached sends own roots so suspension cannot snapshot mid-delivery.
    void runWithGatewayIndependentRootWorkContinuation(
      () =>
        postCronWebhook({
          webhookUrl: completionWebhookUrl,
          webhookToken,
          ssrfPolicy: params.ssrfPolicy,
          payload,
          jobId: params.evt.jobId,
          logger: params.logger,
        }),
      "cron:notification-delivery",
    ).catch((err: unknown) => {
      params.logger.warn(
        { jobId: params.evt.jobId, err: formatErrorMessage(err) },
        "cron: detached notification delivery failed",
      );
    });
  }
}
