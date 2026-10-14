import {
  ErrorCodes,
  errorShape,
  validateCronAddParams,
  validateCronGetParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronStatusParams,
  validateCronUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { bindCronSelfRemovalCommitGuard } from "../../cron/active-jobs.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import {
  resolveCronDeliveryFailurePreview,
  resolveCronDeliveryPreview,
} from "../../cron/delivery-preview.js";
import { cronAddResultReadView, cronJobReadView } from "../../cron/job-read-view.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import type { CronUpdateOptions } from "../../cron/service/state.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type {
  CronDeliveryPreview,
  CronJob,
  CronJobCreate,
  CronJobPatch,
} from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { isRecord } from "../../utils.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../cron-creator-authority-grant.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  applyCronCreateCallerScopeDefault,
  cronCreateMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  cronJobMatchesCallerScope,
  cronPatchSessionRefsMatchCaller,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
  resolveCronMutationCommitGuard,
  resolveCronRequesterProvenanceForJob,
  resolveCronScheduledToolPolicyForCaller,
} from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronHistoryHandler } from "./cron-history.js";
import {
  assertValidCronUpdatePatch,
  captureCronCreatorSession,
  cronRunQueuesBehindCaller,
  requiresExplicitAgentRuntimeToolsAllow,
  normalizeCronAddRequest,
  normalizeCronUpdateRequest,
  assertCronDoesNotTargetAgentHarness,
} from "./cron-input-validation.js";
import {
  assertCronReadCurrent,
  isLegacyCreatorPromptUpdate,
  resolveCronJobId,
  respondInvalidCronParams,
  respondMissingCronJobId,
  respondCronJobNotFound,
  respondRefusedCronAgent,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import { cronListHandler } from "./cron-list.js";
import { cronRunsHandler } from "./cron-runs.js";
import { cronScratchHandlers } from "./cron-scratch.js";
import { cronWakeHandler } from "./cron-wake.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class CronJobConfigRevisionConflictError extends Error {
  constructor(
    readonly expectedConfigRevision: string,
    readonly actualConfigRevision: string,
  ) {
    super("cron job definition no longer matches the loaded version");
  }
}

<<<<<<< HEAD
=======
// Migration provenance (sourceSha256) stays internal; the closed result schema
// exposes only content/revision/updatedAtMs.
function publicCronScratch(
  scratch: { content: string; revision: number; updatedAtMs: number } | undefined,
) {
  if (!scratch) {
    return null;
  }
  return {
    content: scratch.content,
    revision: scratch.revision,
    updatedAtMs: scratch.updatedAtMs,
  };
}

function cronJobReadView(job: CronJob) {
  const publicJob = toPublicCronJob(job);
  return {
    ...publicJob,
    configRevision: resolveCronJobConfigRevision(job),
    nextRunAtMs: job.state.nextRunAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus,
    lastRunError: job.state.lastError,
    lastDelivered: job.state.lastDelivered,
    lastDeliveryStatus: job.state.lastDeliveryStatus,
    lastDeliveryError: job.state.lastDeliveryError,
    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
  };
}

function compactCronListJob(job: CronJob) {
  // Optional declaration/delivery fields are omitted when unset so compact
  // rows stay lean for the common undeclared job.
  return {
    id: job.id,
    name: job.name,
    ...(job.declarationKey ? { declarationKey: job.declarationKey } : {}),
    ...(job.displayName ? { displayName: job.displayName } : {}),
    ...(job.owner ? { owner: job.owner } : {}),
    enabled: job.enabled,
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    scheduleKind: job.schedule.kind,
    ...(job.trigger ? { trigger: true } : {}),
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    ...(job.state.lastDelivered !== undefined ? { lastDelivered: job.state.lastDelivered } : {}),
    ...(job.state.lastDeliveryStatus !== undefined
      ? { lastDeliveryStatus: job.state.lastDeliveryStatus }
      : {}),
    ...(job.state.lastDeliveryError !== undefined
      ? { lastDeliveryError: job.state.lastDeliveryError }
      : {}),
    ...(job.state.lastFailureNotificationDelivered !== undefined
      ? { lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryStatus !== undefined
      ? { lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryError !== undefined
      ? { lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError }
      : {}),
  };
}

async function assertValidCronUpdatePatch(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  currentJob: CronJob;
  patch: CronJobPatch;
}) {
  // Apply the full patch so service-owned payload/session constraints are
  // checked before mutation; configured-channel checks stay delivery-scoped so
  // stale existing delivery does not block unrelated updates like disabling.
  const nextJob = structuredClone(params.currentJob);
  applyJobPatch(nextJob, params.patch, {
    defaultAgentId: params.defaultAgentId,
    cronConfig: params.cfg.cron,
  });
  if (
    "agentId" in params.patch ||
    "sessionTarget" in params.patch ||
    "sessionKey" in params.patch
  ) {
    assertCronDoesNotTargetAgentHarness(nextJob);
  }
  // Clearing a concrete channel (channel: null) while keeping a bare announce `to`
  // intentionally falls back to "last" in multi-channel configs. Use the same
  // adjusted delivery for both the delivery check and the inherited-alert check so
  // an alert that inherits the route is judged identically to the delivery itself.
  const effectiveDelivery =
    params.patch.delivery?.channel === null &&
    nextJob.delivery &&
    (nextJob.delivery.mode ?? "announce") === "announce" &&
    nextJob.delivery.channel === undefined &&
    resolveTargetPrefixedChannel(nextJob.delivery.to) === undefined
      ? { ...nextJob.delivery, channel: "last" as const }
      : nextJob.delivery;
  if ("delivery" in params.patch) {
    await assertValidCronAnnounceDelivery({
      cfg: params.cfg,
      delivery: effectiveDelivery,
    });
  }
  // failureAlert is a separate field from delivery, so a failureAlert-only patch
  // skips the delivery check above. Validate when this edit touches a field that
  // can change the announce channel routing: the alert's own channel/target/mode,
  // or delivery itself (an alert without its own channel/target inherits the job
  // delivery channel, so a delivery change can invalidate it). Editing unrelated
  // alert fields (after/cooldown/includeSkipped) must not be blocked by a channel
  // stored before this validation existed. The merged value carries the effective
  // mode, and the validator no-ops for alerts that only inherit delivery.
  const failureAlertPatch = params.patch.failureAlert;
  const failureAlertRoutingPatched =
    failureAlertPatch &&
    ("channel" in failureAlertPatch || "to" in failureAlertPatch || "mode" in failureAlertPatch);
  // Enabling a previously OFF alert makes it start inheriting the job delivery
  // route, so validate even when the enabling patch (`--failure-alert`,
  // `--failure-alert-after`) carries no routing key of its own. An alert is
  // already ON - so an object-only edit only changes threshold/cooldown - when it
  // has per-job config or when global `cron.failureAlert.enabled` is true;
  // resolveFailureAlert() treats those as active, so re-validating their inherited
  // route would block unrelated edits on a legacy channel that already delivers.
  const globalAlertsEnabled = params.cfg.cron?.failureAlert?.enabled === true;
  const currentAlertActive =
    params.currentJob.failureAlert !== false &&
    (params.currentJob.failureAlert !== undefined || globalAlertsEnabled);
  const nextAlertActive =
    nextJob.failureAlert !== false && (nextJob.failureAlert !== undefined || globalAlertsEnabled);
  const alertNewlyEnabled = !currentAlertActive && nextAlertActive;
  // A delivery change only affects the alert when the alert inherits the changed
  // delivery field (its own channel/to is unset). Gating on that avoids blocking
  // unrelated delivery edits (bestEffort, failureDestination) on jobs that carry
  // a stale explicit alert channel. A delivery `mode` change is included because
  // switching to/from webhook clears the inherited channel/target in
  // mergeCronDelivery, which can make an inheriting alert ambiguous.
  const deliveryPatch = params.patch.delivery;
  const mergedAlert = nextJob.failureAlert;
  const alertUsesInheritedChannel = !mergedAlert || mergedAlert.channel === undefined;
  const alertUsesInheritedTarget = !mergedAlert || mergedAlert.to === undefined;
  const deliveryAffectsInheritedAlert =
    deliveryPatch &&
    nextAlertActive &&
    (("channel" in deliveryPatch && alertUsesInheritedChannel) ||
      ("to" in deliveryPatch && alertUsesInheritedTarget) ||
      ("mode" in deliveryPatch && alertUsesInheritedChannel));
  const currentAlertRoutingOverride =
    params.currentJob.failureAlert &&
    (params.currentJob.failureAlert.channel !== undefined ||
      params.currentJob.failureAlert.to !== undefined ||
      params.currentJob.failureAlert.mode !== undefined);
  const alertResetToGlobal =
    failureAlertPatch === null && nextAlertActive && currentAlertRoutingOverride;
  if (
    failureAlertRoutingPatched ||
    alertNewlyEnabled ||
    deliveryAffectsInheritedAlert ||
    alertResetToGlobal
  ) {
    await assertValidCronFailureAlert({
      cfg: params.cfg,
      failureAlert: nextJob.failureAlert,
      delivery: effectiveDelivery,
    });
  }
  return nextJob;
}

function requiresExplicitAgentRuntimeToolsAllow(params: {
  job: Pick<CronJob, "payload" | "trigger">;
  callerScope: CronCallerScope | undefined;
}): boolean {
  return (
    params.callerScope !== undefined &&
    cronJobUsesToolRuntime(params.job) &&
    params.job.payload.toolsAllow === undefined
  );
}

function cronPatchTouchesToolRuntime(patch: CronJobPatch): boolean {
  // Host-shell precheck is an unattended executable surface. Precheck-only
  // updates must take the same explicit-cap + caller-bound scheduled authority
  // path as payload/trigger tool-runtime mutations.
  return (
    patch.payload !== undefined ||
    Object.hasOwn(patch, "trigger") ||
    Object.hasOwn(patch, "precheck")
  );
}

function assertCronDoesNotTargetAgentHarness(input: {
  agentId?: string | null;
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): void {
  const targetSessionKey =
    resolveCronSessionTargetSessionKey(input.sessionTarget) ??
    (input.sessionTarget === "current" ? input.sessionKey?.trim() : undefined);
  if (!targetSessionKey) {
    return;
  }

  const loaded = loadGatewaySessionEntryReadOnly(
    targetSessionKey,
    input.agentId?.trim() ? { agentId: input.agentId.trim() } : {},
  );
  const reservedKey =
    isAgentHarnessSessionKey(targetSessionKey) || isAgentHarnessSessionKey(loaded.canonicalKey);
  if (loaded.entry?.modelSelectionLocked === true) {
    // Detached cron execution is a generic model path and cannot preserve a
    // harness-owned runtime lock, even when the durable row uses an ordinary key.
    throw new Error(
      reservedKey
        ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
        : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  }
  if (!reservedKey || loaded.entry) {
    // `harness:*` was historically a valid public key. Preserve an existing
    // unlocked row while reserving missing keys for trusted harness creation.
    return;
  }

  // Cron's detached runner does not carry the owning harness lock. Harness
  // execution targets must enter through ordinary session dispatch instead.
  throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
}

function resolveCronJobId(params: CronJobIdParams): string | undefined {
  // Exact store lookups; clipboard/UI padding must not fake "id not found".
  return normalizeOptionalString(params.id ?? params.jobId);
}

function respondInvalidCronParams(respond: RespondFn, method: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${reason}`),
  );
}

function respondMissingCronJobId(respond: RespondFn, method: string): void {
  respondInvalidCronParams(respond, method, "missing id");
}

function respondCronJobNotFound(
  respond: RespondFn,
  jobId: string,
  options: { preserveCronGetWireMessage?: boolean } = {},
): void {
  const message = options.preserveCronGetWireMessage
    ? `cron job not found: ${jobId}. List automations and retry with a current job id.`
    : `Automation not found: ${jobId}. List automations and retry with a current job id.`;
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, message, {
      details: { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId },
    }),
  );
}

/** Gateway request handlers for cron jobs and cron run-log access. */
>>>>>>> e45bee97e4d (fix(cron): classify precheck patches as tool-runtime authority)
export const cronHandlers: GatewayRequestHandlers = {
  wake: cronWakeHandler,
  "cron.list": cronListHandler,
  "cron.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCronStatusParams, "cron.status", respond)) {
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.get": scopedCronJobHandler(
    "cron.get",
    validateCronGetParams,
    ({ respond }, { job }) => respond(true, cronJobReadView(job), undefined),
    {
      allowCurrentJob: true,
      checkVisibility: true,
      // Shipped CLI matchers parse this wording for name lookup fallback.
      preserveCronGetWireMessage: true,
    },
  ),
  ...cronScratchHandlers,
  "cron.add": async ({
    params,
    respond,
    context,
    client,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    let candidate: unknown;
    let enabledExplicit: boolean;
    try {
      ({ candidate, enabledExplicit } = normalizeCronAddRequest(params));
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    if (!assertValidParams(candidate, validateCronAddParams, "cron.add", respond)) {
      return;
    }
    const callerScope = readCronCallerScope(client);
    const jobCreate = applyCronCreateCallerScopeDefault(candidate as CronJobCreate, callerScope);
    let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
    let assertCapturedAuthorityCurrent: (() => void) | undefined;
    try {
      const capture = resolveCronCreatorAuthorityCapture(callerScope);
      captureRuntimeAuthority = capture?.captureRuntimeAuthority;
      assertCapturedAuthorityCurrent = capture?.assertCurrent;
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    const assertMutationCurrent = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    });
    const cfg = context.getRuntimeConfig();
    if (
      !cronCreateMatchesCallerScope({
        job: jobCreate,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondInvalidCronParams(respond, "cron.add", "job agentId outside caller scope");
      return;
    }
    if (requiresExplicitAgentRuntimeToolsAllow({ job: jobCreate, callerScope })) {
      respondInvalidCronParams(
        respond,
        "cron.add",
        "agent-runtime tool jobs require an explicit payload.toolsAllow cap",
      );
      return;
    }
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    if (
      respondRefusedCronAgent(
        tryResolveCronJobEffectiveAgentId(jobCreate, context.cron.getDefaultAgentId()),
        respond,
      )
    ) {
      return;
    }
    const creatorOptions = await captureCronCreatorSession(jobCreate, callerScope, client, cfg);
    const commitGuard = () => {
      assertMutationCurrent?.();
      assertCapturedAuthorityCurrent?.();
    };
    try {
      await assertCronDoesNotTargetAgentHarness(jobCreate, cfg);
      await assertValidCronCreateDelivery(cfg, jobCreate);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    // Resolve before the durable add. A preview failure after commit would make a safe retry
    // create a duplicate job.
    const previewContext = { cfg, defaultAgentId: context.cron.getDefaultAgentId() };
    const deliveryPreview = await resolveCronDeliveryPreview({
      ...previewContext,
      job: { ...jobCreate, sourceConversation: creatorOptions.sourceConversation },
    });
    let result: Awaited<ReturnType<typeof context.cron.add>>;
    try {
      result = await context.cron.add(jobCreate, {
        enabledExplicit,
        ...creatorOptions,
        commitGuard,
        ...(captureRuntimeAuthority ? { captureRuntimeAuthority } : {}),
        matchesExisting: (job) =>
          cronJobMatchesDeclarationScope({
            job,
            input: jobCreate,
            callerScope,
            defaultAgentId: context.cron.getDefaultAgentId(),
          }),
        ...(cronJobUsesToolRuntime(jobCreate)
          ? {
              scheduledToolPolicy: resolveCronScheduledToolPolicyForCaller(callerScope),
              ...(callerScope?.toolsAllowProvenance
                ? { toolsAllowProvenance: callerScope.toolsAllowProvenance }
                : {}),
              ...(callerScope?.toolsAllowExecTarget
                ? { toolsAllowExecTarget: callerScope.toolsAllowExecTarget }
                : {}),
            }
          : {}),
      });
    } catch (err) {
      if (
        !(err instanceof TypeError) &&
        !(err instanceof RangeError) &&
        !isCronInvalidRequestError(err)
      ) {
        throw err;
      }
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    const job = "job" in result ? result.job : result;
    context.logGateway.info("cron: job added", {
      jobId: job.id,
      declarationKey: job.declarationKey,
      schedule: jobCreate.schedule,
    });
    respond(
      true,
      cronAddResultReadView({
        result,
        deliveryPreview:
          "job" in result && !result.created
            ? await resolveCronDeliveryPreview({ ...previewContext, job })
            : deliveryPreview,
      }),
      undefined,
    );
  },
  "cron.update": async ({
    params,
    respond,
    context,
    client,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    let candidate: unknown;
    let normalizedPatch: CronJobPatch | null;
    try {
      ({ candidate, normalizedPatch } = normalizeCronUpdateRequest(params));
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    if (!assertValidParams(candidate, validateCronUpdateParams, "cron.update", respond)) {
      return;
    }
    if (!normalizedPatch) {
      respondInvalidCronParams(respond, "cron.update", "patch did not normalize");
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
      expectedConfigRevision?: string;
    };
    const callerScope = readCronCallerScope(client);
    const jobId = resolveCronJobId(p);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.update");
      return;
    }
    const patch: CronJobPatch = normalizedPatch;
    const cfg = context.getRuntimeConfig();
    const currentJob = await context.cron.readJob(jobId);
    if (
      !currentJob ||
      !cronJobMatchesCallerScope({
        job: currentJob,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    const creatorScope =
      callerScope?.manageAll &&
      (!callerScope.sessionKey ||
        currentJob.owner?.sessionKey !== callerScope.sessionKey ||
        normalizeAccountId(currentJob.owner?.accountId) !== callerScope.accountId)
        ? undefined
        : callerScope && { ...callerScope, manageAll: undefined };
    let capture: ReturnType<typeof resolveCronCreatorAuthorityCapture>;
    if (callerScope && !callerScope.manageAll && "agentId" in patch) {
      respondInvalidCronParams(respond, "cron.update", "agentId cannot be changed by caller scope");
      return;
    }
    if (!cronPatchSessionRefsMatchCaller(patch, callerScope)) {
      respondInvalidCronParams(respond, "cron.update", "session target outside caller scope");
      return;
    }
    if (
      ("agentId" in patch || "sessionTarget" in patch || "sessionKey" in patch) &&
      respondRefusedCronAgent(
        tryResolveCronJobEffectiveAgentId(
          { ...currentJob, ...patch },
          context.cron.getDefaultAgentId(),
        ),
        respond,
      )
    ) {
      return;
    }
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    const touchesToolRuntime = patch.payload !== undefined || Object.hasOwn(patch, "trigger");
    let deliveryPreview: CronDeliveryPreview | undefined;
    const validateUpdate = async (jobToUpdate: CronJob) => {
      const nextJob = await assertValidCronUpdatePatch({
        cfg,
        defaultAgentId: context.cron.getDefaultAgentId(),
        currentJob: jobToUpdate,
        patch,
      });
      if (
        callerScope?.manageAll &&
        creatorScope &&
        patch.payload?.toolsAllow?.length &&
        (!capture ||
          jobToUpdate.owner?.sessionKey !== creatorScope.sessionKey ||
          !cronJobMatchesCallerScope({ job: jobToUpdate, callerScope: creatorScope }) ||
          !cronCreateMatchesCallerScope({ job: nextJob, callerScope: creatorScope }))
      ) {
        throw new TypeError(
          `Cannot authorize toolsAllow: ${patch.payload?.toolsAllow?.join(", ") ?? ""}. Recreate the automation from a fresh authenticated owner turn to capture app authority.`,
        );
      }
      if (
        touchesToolRuntime &&
        requiresExplicitAgentRuntimeToolsAllow({ job: nextJob, callerScope }) &&
        !isLegacyCreatorPromptUpdate(jobToUpdate, patch, callerScope)
      ) {
        throw new TypeError("agent-runtime tool jobs require an explicit payload.toolsAllow cap");
      }
      return nextJob;
    };
    try {
      capture = resolveCronCreatorAuthorityCapture(creatorScope);
      await validateUpdate(currentJob);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const commitGuard = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard: capture
        ? () => {
            sessionMutationCommitGuard?.();
            capture?.assertCurrent();
          }
        : sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    });
    const updateOptions: CronUpdateOptions | undefined =
      touchesToolRuntime || commitGuard || capture || callerScope?.toolsAllowProvenance
        ? {
            ...(touchesToolRuntime
              ? {
                  scheduledToolPolicy:
                    callerScope?.manageAll && !capture
                      ? null
                      : resolveCronScheduledToolPolicyForCaller(callerScope),
                  toolsAllowExecTarget: callerScope?.toolsAllowExecTarget,
                }
              : {}),
            ...(commitGuard ? { commitGuard } : {}),
            ...(capture ? { captureRuntimeAuthority: capture.captureRuntimeAuthority } : {}),
          }
        : undefined;
    let job: Awaited<ReturnType<typeof context.cron.update>>;
    try {
      job = await context.cron.updateWithPrecondition(
        jobId,
        patch,
        async (lockedJob) => {
          if (
            !cronJobMatchesCallerScope({
              job: lockedJob,
              callerScope,
              defaultAgentId: context.cron.getDefaultAgentId(),
            })
          ) {
            throw new Error(`unknown cron job id: ${jobId}`);
          }
          if (p.expectedConfigRevision !== undefined) {
            const actualConfigRevision = resolveCronJobConfigRevision(lockedJob);
            if (actualConfigRevision !== p.expectedConfigRevision) {
              throw new CronJobConfigRevisionConflictError(
                p.expectedConfigRevision,
                actualConfigRevision,
              );
            }
          }
          const nextJob = await validateUpdate(lockedJob);
          deliveryPreview = await resolveCronDeliveryFailurePreview({
            cfg,
            defaultAgentId: context.cron.getDefaultAgentId(),
            job: nextJob,
          });
          if (updateOptions) {
            updateOptions.toolsAllowProvenance = resolveCronRequesterProvenanceForJob(
              lockedJob,
              readCronCallerScope(client),
            );
          }
        },
        updateOptions,
      );
    } catch (err) {
      if (err instanceof CronJobConfigRevisionConflictError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "cron job definition no longer matches the loaded version; review the latest version before retrying",
            {
              details: {
                code: "CRON_JOB_CHANGED",
                expectedConfigRevision: err.expectedConfigRevision,
                actualConfigRevision: err.actualConfigRevision,
              },
            },
          ),
        );
        return;
      }
      if (
        !(err instanceof TypeError) &&
        !(err instanceof RangeError) &&
        !isCronInvalidRequestError(err)
      ) {
        throw err;
      }
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    context.logGateway.info("cron: job updated", { jobId });
    respond(
      true,
      { ...cronJobReadView(job), ...(deliveryPreview ? { deliveryPreview } : {}) },
      undefined,
    );
  },
  "cron.remove": scopedCronJobHandler(
    "cron.remove",
    validateCronRemoveParams,
    async (
      { respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope, job },
    ) => {
      const defaultAgentId = context.cron.getDefaultAgentId();
      const usesCurrentJobCapability = !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId,
      });
      const expectedConfigRevision = usesCurrentJobCapability
        ? resolveCronJobConfigRevision(job)
        : undefined;
      let result: Awaited<ReturnType<typeof context.cron.remove>>;
      try {
        const commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          {
            callerScope,
            jobId,
            allowCurrentJob: usesCurrentJobCapability,
            expectedConfigRevision,
          },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const identity = client?.internal?.agentRuntimeIdentity;
        const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
        if (identity && validateAuthority && commitGuard && callerScope?.currentJobId === jobId) {
          bindCronSelfRemovalCommitGuard(
            jobId,
            identity.operationalRunInstance,
            commitGuard,
            () => {
              if (
                !validateAuthority(identity) ||
                readCronCallerScope(client)?.currentJobId !== jobId
              ) {
                throw new TypeError("cron self-removal authority is no longer active");
              }
            },
          );
        }
        result = commitGuard
          ? await context.cron.remove(jobId, { commitGuard })
          : await context.cron.remove(jobId);
      } catch (error) {
        if (error instanceof TypeError || isCronInvalidRequestError(error)) {
          respondInvalidCronParams(respond, "cron.remove", formatErrorMessage(error));
          return;
        }
        throw error;
      }
      if (!result.removed) {
        respondCronJobNotFound(respond, jobId);
        return;
      }
      context.logGateway.info("cron: job removed", { jobId });
      respond(true, result, undefined);
    },
    { allowCurrentJob: true },
  ),
  "cron.run": scopedCronJobHandler(
    "cron.run",
    validateCronRunParams,
    async (options, { jobId, callerScope, job }) => {
      const {
        params: p,
        respond,
        context,
        client,
        sessionMutationCommitGuard,
        hasCurrentClientAuthority,
      } = options;
      if (
        p.expectedProcessInstanceId &&
        p.expectedProcessInstanceId !== getGatewayProcessInstanceId()
      ) {
        respondInvalidCronParams(respond, "cron.run", "Gateway process changed after preflight");
        return;
      }
      let result: Awaited<ReturnType<typeof context.cron.enqueueRun>>;
      try {
        const commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        result = commitGuard
          ? await context.cron.enqueueRun(jobId, p.mode ?? "force", { commitGuard })
          : await context.cron.enqueueRun(jobId, p.mode ?? "force");
      } catch (error) {
        if (error instanceof TypeError) {
          respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
          return;
        }
        if (isInvalidCronSessionTargetIdError(error)) {
          respond(true, { ok: true, ran: false, reason: "invalid-spec" }, undefined);
          return;
        }
        if (isCronInvalidRequestError(error)) {
          respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
          return;
        }
        throw error;
      }
      const ack = { ...result, processInstanceId: getGatewayProcessInstanceId() };
      const callerSessionKey = client?.internal?.agentRuntimeIdentity?.sessionKey;
      const runQueuesBehindCaller =
        p.waitTimeoutMs !== undefined &&
        "enqueued" in result &&
        (await cronRunQueuesBehindCaller({
          job,
          cfg: context.getRuntimeConfig(),
          callerSessionKey,
          resolveDefaultAgentId: () => context.cron.getDefaultAgentId(),
        }));
      let run: unknown;
      let finished = false;
      // cron.run stays an enqueue (#40192); waiting is opt-in and bounded by the caller.
      // The outcome is read through cron.runs so it honors the same history visibility.
      if (p.waitTimeoutMs !== undefined && "enqueued" in result && !runQueuesBehindCaller) {
        finished = await context.cron.waitForManualRun(
          result.runId,
          p.waitTimeoutMs,
          options.signal,
        );
      }
      if (finished && "enqueued" in result) {
        try {
          await cronRunsHandler({
            ...options,
            params: { id: jobId, runId: result.runId, limit: 1 },
            respond: (ok, page) => {
              run =
                ok && isRecord(page) && Array.isArray(page.entries) ? page.entries[0] : undefined;
            },
          });
          // The mutation response skips the read-response guard, so recheck read authority
          // with no await between the check and releasing the outcome.
          assertCronReadCurrent(options);
          const identity = client?.internal?.agentRuntimeIdentity;
          if (identity) {
            getCronManagementAuthority(identity)?.();
          }
        } catch {
          // Authority can lapse during a long wait (grant expiry, revocation). The run is
          // already accepted, so return only its ack and release nothing about the outcome.
          run = undefined;
          finished = false;
        }
      }
      respond(true, run ? { ...ack, run } : finished ? { ...ack, finished } : ack, undefined);
    },
  ),
  "cron.history": cronHistoryHandler,
  "cron.runs": cronRunsHandler,
};

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
for (const [method, handler] of Object.entries(cronHandlers)) {
  const wrapped: GatewayRequestHandler = async (args) => {
    const identity = args.client?.internal?.agentRuntimeIdentity;
    if (!identity) {
      return await handler(args);
    }
    const grant = identity.cronManagementGrant;
    let succeeded = false;
    const run = async () => {
      assertActiveAgentRuntimeAuthority(args.client, args.context);
      await handler({
        ...args,
        respond: (...response) => {
          // Reads release data here; mutations already checked at commit. A late
          // acknowledgement must not turn a committed effect into a retryable denial.
          if (
            method === "cron.list" ||
            method === "cron.get" ||
            method === "cron.runs" ||
            method === "cron.history"
          ) {
            assertActiveAgentRuntimeAuthority(args.client, args.context);
            getCronManagementAuthority(identity)?.();
          }
          succeeded = response[0];
          args.respond(...response);
        },
      });
    };
    try {
      await (grant ? withCronManagementGrant(grant, identity, method, run) : run());
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      respondInvalidCronParams(args.respond, method, error.message);
    } finally {
      if (grant) {
        args.context.logGateway.info("cron: admin management", {
          method,
          runId: identity.operationalRunInstance.runId,
          instanceId: identity.operationalRunInstance.instanceId,
          ok: succeeded,
        });
      }
    }
  };
  if (handler.prepareRead) {
    const prepareRead = handler.prepareRead;
    wrapped.prepareRead = (args) =>
      args.client?.internal?.agentRuntimeIdentity
        ? { run: (respond) => wrapped({ ...args, respond }) }
        : prepareRead(args);
  }
  cronHandlers[method] = wrapped;
}
