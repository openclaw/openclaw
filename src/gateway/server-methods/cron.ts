import {
  ErrorCodes,
  errorShape,
  validateCronGetParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronStatusParams,
  validateCronUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureCronStreamSandboxTarget } from "../../agents/sandbox/stream-context.js";
import { bindCronSelfRemovalCommitGuard } from "../../cron/active-jobs.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { resolveCronDeliveryFailurePreview } from "../../cron/delivery-preview.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import type { CronUpdateOptions } from "../../cron/service/state.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import { CronStoreSelectionRequiredError } from "../../cron/store/selection-error.js";
import { CronStreamApprovalEndedError } from "../../cron/stream-approval-outcome.js";
import { cronUpdateRequiresStreamExecAuthority } from "../../cron/stream-exec-authority.js";
import type { CronDeliveryPreview, CronJobPatch, CronStoredJob } from "../../cron/types.js";
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
import { cronAddHandler } from "./cron-add.js";
import { cronBindHandler } from "./cron-bind.js";
import {
  assertCronModelJobAllowed,
  cronCreateMatchesCallerScope,
  cronJobMatchesCallerScope,
  cronPatchSessionRefsMatchCaller,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
  resolveCronStreamExecPolicy,
  resolveCronMutationCommitGuard,
  resolveCronRequesterProvenanceForJob,
  resolveCronScheduledToolPolicyForCaller,
} from "./cron-caller-scope.js";
import { prepareCronCreatorSession } from "./cron-creator-session.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronHistoryHandler } from "./cron-history.js";
import {
  assertValidCronUpdatePatch,
  captureCronCreatorSession,
  captureCronUpdatedInferenceBinding,
  cronRunQueuesBehindCaller,
  normalizeCronUpdateRequest,
} from "./cron-input-validation.js";
import {
  assertCronReadCurrent,
  assertTrustedJobNarrowingOwner,
  cronUpdateNarrowsTrustedJob,
  resolveCronJobId,
  respondInvalidCronParams,
  respondMissingCronJobId,
  respondCronJobNotFound,
  respondRefusedCronAgent,
  resolveCronScopedToolEditRefusal,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import { cronListHandler } from "./cron-list.js";
import { cronLiveOutputHandler } from "./cron-live-output.js";
import { respondCronJobConfigRevisionConflict } from "./cron-revision-error.js";
import { cronRunsHandler } from "./cron-runs.js";
import { cronScratchHandlers } from "./cron-scratch.js";
import { withCronStreamExecApproval } from "./cron-stream-approval.js";
import { cronWakeHandler } from "./cron-wake.js";
import type { GatewayReadErrorHandler } from "./prepared-read.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronHandlers: GatewayRequestHandlers = {
  wake: cronWakeHandler,
  "cron.list": cronListHandler,
  "cron.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCronStatusParams, "cron.status", respond)) {
      return;
    }
    respond(true, await context.cron.status(), undefined);
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
  "cron.add": cronAddHandler,
  "cron.bind": cronBindHandler,
  "cron.update": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  }) => {
    assertActiveAgentRuntimeAuthority(client, context);
    sessionMutationCommitGuard?.();
    if (hasCurrentClientAuthority?.() === false) {
      throw new Error("Automation caller authority is no longer active");
    }
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
    let inference: Awaited<ReturnType<typeof captureCronUpdatedInferenceBinding>>;
    let operatorCapture: Awaited<ReturnType<typeof captureCronCreatorSession>> | undefined;
    let operatorSourceExecutionRevision: string | undefined;
    let streamExecPolicy: ReturnType<typeof resolveCronStreamExecPolicy>;
    let creatorSessionId: string | undefined;
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
    const narrowsTrustedJob = cronUpdateNarrowsTrustedJob(currentJob, patch, callerScope);
    let deliveryPreview: CronDeliveryPreview | undefined;
    const validateUpdate = async (jobToUpdate: CronStoredJob) => {
      assertCronModelJobAllowed(client, cfg, jobToUpdate, patch);
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
        // Without a fresh capture, only a job holding app authority would lose it.
        ((!capture && jobToUpdate.runtimeAuthority !== undefined) ||
          jobToUpdate.owner?.sessionKey !== creatorScope.sessionKey ||
          !cronJobMatchesCallerScope({ job: jobToUpdate, callerScope: creatorScope }) ||
          !cronCreateMatchesCallerScope({ job: nextJob, callerScope: creatorScope }))
      ) {
        throw new TypeError(
          `Cannot authorize toolsAllow: ${patch.payload?.toolsAllow?.join(", ") ?? ""}. Recreate the automation from a fresh authenticated owner turn to capture app authority.`,
        );
      }
      // The locked definition decides; a job that became trusted (or stopped being) while this
      // update waited would otherwise keep a narrowing decision made for a different authority.
      if (cronUpdateNarrowsTrustedJob(jobToUpdate, patch, callerScope) !== narrowsTrustedJob) {
        throw new TypeError(
          "This automation changed while the update was pending. Read it again and retry.",
        );
      }
      if (narrowsTrustedJob) {
        assertTrustedJobNarrowingOwner(jobToUpdate, callerScope);
      }
      const refusal = touchesToolRuntime
        ? resolveCronScopedToolEditRefusal({ job: jobToUpdate, nextJob, patch, callerScope })
        : undefined;
      if (refusal) {
        throw new TypeError(refusal);
      }
      return nextJob;
    };
    try {
      streamExecPolicy = resolveCronStreamExecPolicy(
        client,
        cronUpdateRequiresStreamExecAuthority(patch, currentJob),
        context,
      );
      capture = resolveCronCreatorAuthorityCapture(creatorScope);
      const runtimeAuthority = capture?.captureRuntimeAuthority();
      capture &&= { ...capture, captureRuntimeAuthority: () => runtimeAuthority };
      const nextJob = await validateUpdate(currentJob);
      if (creatorScope) {
        operatorSourceExecutionRevision = resolveCronOperatorExecutionRevision(nextJob);
        operatorCapture = await captureCronCreatorSession(
          nextJob,
          creatorScope,
          { client, context, signal },
          cfg,
          true,
        );
      }
      inference = runtimeAuthority
        ? undefined
        : await captureCronUpdatedInferenceBinding(nextJob, patch, cfg, {
            client,
            context,
            signal,
          });
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const commitGuard = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard: () => {
        sessionMutationCommitGuard?.();
        capture?.assertCurrent();
        inference?.assertInferenceSelectionCurrent();
        operatorCapture?.assertOperatorSourceCurrent?.();
      },
      hasCurrentClientAuthority,
      modelJobPolicy: { config: cfg, jobId, patch },
    });
    const updateOptions: CronUpdateOptions = {
      ...(operatorCapture?.operatorSource
        ? { operatorSource: operatorCapture.operatorSource, operatorSourceExecutionRevision }
        : {}),
      ...(touchesToolRuntime || narrowsTrustedJob
        ? {
            scheduledToolPolicy:
              callerScope?.manageAll && !capture
                ? null
                : resolveCronScheduledToolPolicyForCaller(callerScope),
            toolsAllowExecTarget: callerScope?.toolsAllowExecTarget,
          }
        : {}),
      ...(inference?.inferenceBinding ? { inferenceBinding: inference.inferenceBinding } : {}),
      commitGuard,
      ...(capture ? { captureRuntimeAuthority: capture.captureRuntimeAuthority } : {}),
    };
    let job: Awaited<ReturnType<typeof context.cron.update>>;
    try {
      if (currentJob.streamSandbox && streamExecPolicy && !streamExecPolicy.sandboxContext) {
        assertActiveAgentRuntimeAuthority(client, context);
        throw new TypeError("Change this sandbox stream from its original sandbox session.");
      }
      if (streamExecPolicy) {
        const creator = await prepareCronCreatorSession({
          context,
          client,
          callerScope,
          sessionMutationCommitGuard,
          hasCurrentClientAuthority,
          retainExecutionPolicy: true,
        });
        if (!updateOptions) {
          throw new TypeError("A stream change requires its current creator authority.");
        }
        if (streamExecPolicy.sandboxContext) {
          if (!creator.session) {
            throw new TypeError("A sandbox stream requires its current creator session.");
          }
          const streamSandbox = captureCronStreamSandboxTarget({
            sandbox: streamExecPolicy.sandboxContext,
            ...creator.session,
          });
          if (
            currentJob.streamSandbox &&
            (currentJob.streamSandbox.scopeKey !== streamSandbox.scopeKey ||
              currentJob.streamSandbox.sessionId !== streamSandbox.sessionId)
          ) {
            assertActiveAgentRuntimeAuthority(client, context);
            throw new TypeError("Change this sandbox stream from its original sandbox session.");
          }
          updateOptions.streamSandbox = streamSandbox;
        }
        updateOptions.sessionEntryCurrent = creator.sessionEntryCurrent;
        creatorSessionId = creator.session?.entry.sessionId;
        updateOptions.commitGuard = () => {
          commitGuard?.();
          creator.assertCurrent();
          streamExecPolicy?.assertCurrentSource?.();
        };
      }
      job = await withCronStreamExecApproval({
        context,
        client,
        creatorSessionId,
        sandboxContext: streamExecPolicy?.sandboxContext,
        assertCurrent: () => updateOptions?.commitGuard?.(),
        onApprovalCommitted: (receipt) => streamExecPolicy?.onApprovalCommitted?.(receipt),
        mutate: (streamExecApproval) => {
          if (updateOptions && streamExecApproval) {
            updateOptions.streamExecApproval = streamExecApproval;
          }
          return context.cron.updateWithPrecondition(
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
              const requiresStreamExec = cronUpdateRequiresStreamExecAuthority(patch, lockedJob);
              if (requiresStreamExec && !streamExecPolicy) {
                streamExecPolicy = resolveCronStreamExecPolicy(client, true, context);
              }
              const execPolicy = requiresStreamExec ? streamExecPolicy : undefined;
              const nextJob = await validateUpdate(lockedJob);
              deliveryPreview = await resolveCronDeliveryFailurePreview({
                cfg,
                defaultAgentId: context.cron.getDefaultAgentId(),
                job: nextJob,
              });
              if (updateOptions) {
                updateOptions.execPolicy = execPolicy;
                // Approval resumes in the resolver's async context. Keep the
                // admitted requester's provenance; commitGuard still checks liveness.
                updateOptions.toolsAllowProvenance = resolveCronRequesterProvenanceForJob(
                  lockedJob,
                  callerScope,
                );
              }
            },
            updateOptions,
          );
        },
      });
    } catch (err) {
      if (err instanceof CronStreamApprovalEndedError) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, err.message, {
            details: err.details,
            retryable: false,
          }),
        );
        return;
      }
      if (err instanceof CronJobConfigRevisionConflictError) {
        respondCronJobConfigRevisionConflict(respond, err);
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
    } finally {
      inference?.disposeInferenceAuthorization();
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
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
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
      const removalRevision = params.expectedConfigRevision ?? expectedConfigRevision;
      let result: Awaited<ReturnType<typeof context.cron.remove>>;
      try {
        let commitGuard = resolveCronMutationCommitGuard(
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
          commitGuard = bindCronSelfRemovalCommitGuard(
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
        result =
          commitGuard || removalRevision !== undefined
            ? await context.cron.remove(jobId, {
                ...(commitGuard ? { commitGuard } : {}),
                ...(removalRevision !== undefined
                  ? { expectedConfigRevision: removalRevision }
                  : {}),
              })
            : await context.cron.remove(jobId);
      } catch (error) {
        if (error instanceof CronJobConfigRevisionConflictError) {
          respondCronJobConfigRevisionConflict(respond, error);
          return;
        }
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
      const cfg = context.getRuntimeConfig();
      try {
        assertCronModelJobAllowed(client, cfg, job);
        const commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId },
          {
            sessionMutationCommitGuard,
            hasCurrentClientAuthority,
            modelJobPolicy: { config: cfg, jobId },
          },
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
      const runQueuesBehindCaller =
        p.waitTimeoutMs !== undefined &&
        "enqueued" in result &&
        (await cronRunQueuesBehindCaller({
          job,
          cfg: context.getRuntimeConfig(),
          caller: client?.internal?.agentRuntimeIdentity,
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
  "cron.liveOutput": cronLiveOutputHandler,
  "cron.runs": cronRunsHandler,
};

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
for (const [method, handler] of Object.entries(cronHandlers)) {
  const invoke: GatewayRequestHandler = async (args) => {
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
            method === "cron.history" ||
            method === "cron.liveOutput"
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
  const respondError: GatewayReadErrorHandler = (error, args) => {
    if (!(error instanceof CronStoreSelectionRequiredError)) {
      if (handler.onReadError) {
        handler.onReadError(error, args);
        return;
      }
      throw error;
    }
    assertCronReadCurrent(args);
    args.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, error.message, {
        retryable: false,
        details: { code: error.code, selection: error.selection },
      }),
    );
  };
  const wrapped: GatewayRequestHandler = async (args) => {
    try {
      await invoke(args);
    } catch (error) {
      respondError(error, args);
    }
  };
  if (handler.prepareRead) {
    const prepareRead = handler.prepareRead;
    wrapped.prepareRead = (args) =>
      args.client?.internal?.agentRuntimeIdentity
        ? { run: (respond) => wrapped({ ...args, respond }) }
        : prepareRead(args);
    wrapped.onReadError = respondError;
  }
  cronHandlers[method] = wrapped;
}
