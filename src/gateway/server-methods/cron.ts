import {
  ErrorCodes,
  errorShape,
  validateCronAddParams,
  validateCronGetParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
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
import { isSubagentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../cron-creator-authority-grant.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
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

export const cronHandlers: GatewayRequestHandlers = {
  wake: async ({ params, respond, context, client, sessionMutationCommitGuard }) => {
    if (!assertValidParams(params, validateWakeParams, "wake", respond)) {
      return;
    }
    // Caller-supplied sessionKey / agentId thread through to `cron.wake` so
    // multi-session deployments wake the originating conversation lane
    // instead of the heartbeat / main default. Empty strings are dropped
    // (schema permits omission; presence with empty payload should not
    // override the default).
    const p = params;
    const sessionKey = p.sessionKey?.trim() || undefined;
    const agentId = p.agentId?.trim() || undefined;
    const callerScope = readCronCallerScope(client);
    const requestedOwner = sessionKey
      ? resolveRequestedSessionAgentId(
          context.getRuntimeConfig(),
          sessionKey,
          agentId ?? callerScope?.agentId,
        )
      : undefined;
    if (requestedOwner && !requestedOwner.ok) {
      respond(false, undefined, requestedOwner.error);
      return;
    }
    const resolvedAgentId = requestedOwner?.agentId ?? callerScope?.agentId ?? agentId;
    if (sessionKey && isAgentHarnessSessionKey(sessionKey)) {
      const loaded = loadGatewaySessionEntryReadOnly(
        sessionKey,
        resolvedAgentId ? { agentId: resolvedAgentId } : {},
      );
      const harnessSessionError = loaded.entry
        ? resolveAgentHarnessSessionStoreEntryError(loaded.canonicalKey, loaded.entry)
        : AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE;
      if (harnessSessionError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, harnessSessionError));
        return;
      }
    }
    if (sessionKey && isSubagentSessionKey(sessionKey)) {
      // Wake requests resume user-visible sessions only; subagent sessions are
      // internal task execution targets and should not receive operator wakes.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake sessionKey cannot target a subagent session"),
      );
      return;
    }
    // The resolver normalizes agent ids. Reject conflicting raw spellings too,
    // so an explicitly named target is never silently rewritten.
    const sessionKeyAgentId = sessionKey
      ? parseAgentSessionKey(sessionKey)?.agentId?.trim().toLowerCase()
      : undefined;
    if (callerScope && agentId && normalizeAgentId(agentId) !== callerScope.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake agentId outside caller scope"),
      );
      return;
    }
    if (agentId && sessionKeyAgentId && agentId.toLowerCase() !== sessionKeyAgentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "wake agentId contradicts the agent that owns sessionKey; pass a single canonical wake target",
        ),
      );
      return;
    }
    const wakeConfig = context.getRuntimeConfig();
    if (respondRefusedCronAgent(resolvedAgentId, respond)) {
      return;
    }
    // Resolving a default wake agent can fail; role-free requests must retain their existing path.
    if (wakeConfig.gateway?.roles) {
      const knownWakeAgentId = resolvedAgentId ?? context.cron.getDefaultAgentId();
      const wakeAgent = knownWakeAgentId
        ? { ok: true as const, agentId: knownWakeAgentId }
        : resolveRequestedSessionAgentId(wakeConfig, sessionKey ?? "main");
      if (!wakeAgent.ok) {
        respond(false, undefined, wakeAgent.error);
        return;
      }
      const wakeAccessError = authorizeGatewaySessionCreation({
        cfg: wakeConfig,
        client,
        agentId: wakeAgent.agentId,
      });
      if (wakeAccessError) {
        respond(false, undefined, wakeAccessError);
        return;
      }
    }
    // Gateway becomes request-ready before scheduled services start; load the
    // wake owner first so an early operator event cannot disappear on cold start.
    await context.cron.prepareWake?.();
    sessionMutationCommitGuard?.();
    assertActiveAgentRuntimeAuthority(client, context);
    const result = context.cron.wake({
      mode: p.mode,
      text: p.text,
      ...(sessionKey ? { sessionKey } : {}),
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    });
    respond(true, result, undefined);
  },
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
    const { assertCurrent: assertCreatorSessionCurrent, ...creatorOptions } =
      captureCronCreatorSession(jobCreate, callerScope, client);
    const commitGuard = () => {
      assertMutationCurrent?.();
      assertCapturedAuthorityCurrent?.();
      assertCreatorSessionCurrent();
    };
    try {
      assertCronDoesNotTargetAgentHarness(jobCreate);
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
    let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
    let assertCapturedAuthorityCurrent: (() => void) | undefined;
    try {
      const capture = resolveCronCreatorAuthorityCapture(callerScope);
      captureRuntimeAuthority = capture?.captureRuntimeAuthority;
      assertCapturedAuthorityCurrent = capture?.assertCurrent;
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const commitGuard = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard: assertCapturedAuthorityCurrent
        ? () => {
            sessionMutationCommitGuard?.();
            assertCapturedAuthorityCurrent?.();
          }
        : sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    });
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
        touchesToolRuntime &&
        requiresExplicitAgentRuntimeToolsAllow({ job: nextJob, callerScope }) &&
        !isLegacyCreatorPromptUpdate(jobToUpdate, patch, callerScope)
      ) {
        throw new TypeError("agent-runtime tool jobs require an explicit payload.toolsAllow cap");
      }
      return nextJob;
    };
    try {
      await validateUpdate(currentJob);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const updateOptions: CronUpdateOptions | undefined =
      touchesToolRuntime ||
      commitGuard ||
      captureRuntimeAuthority ||
      callerScope?.toolsAllowProvenance
        ? {
            // Management access preserves the job's existing execution ceiling.
            ...(touchesToolRuntime
              ? {
                  scheduledToolPolicy: callerScope?.manageAll
                    ? null
                    : resolveCronScheduledToolPolicyForCaller(callerScope),
                  toolsAllowExecTarget: callerScope?.toolsAllowExecTarget,
                }
              : {}),
            ...(commitGuard ? { commitGuard } : {}),
            ...(captureRuntimeAuthority ? { captureRuntimeAuthority } : {}),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
