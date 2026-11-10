import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  validateCronUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureCronStreamSandboxTarget } from "../../agents/sandbox/stream-context.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../../cron/config-revision.js";
import { resolveCronDeliveryFailurePreview } from "../../cron/delivery-preview.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import type { CronUpdateOptions } from "../../cron/service/state.js";
import { CronStreamApprovalEndedError } from "../../cron/stream-approval-outcome.js";
import { cronUpdateRequiresStreamExecAuthority } from "../../cron/stream-exec-authority.js";
import type { CronDeliveryPreview, CronJobPatch, CronStoredJob } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { retainCronControlSource } from "../cron-operator-source.js";
import type { OperatorRunRecoverySnapshot } from "../operator-run-recovery-source.codec.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
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
import {
  assertHumanCronJobAccess,
  assertHumanCronExecutionAccess,
  prepareHumanCronTargetAccess,
  canHumanManageCronJob,
  prepareCronOwnerChange,
} from "./cron-human-owner.js";
import {
  assertValidCronUpdatePatch,
  captureCronCreatorSession,
  captureCronUpdatedInferenceBinding,
  normalizeCronUpdateRequest,
} from "./cron-input-validation.js";
import {
  assertTrustedJobNarrowingOwner,
  cronUpdateNarrowsTrustedJob,
  resolveCronJobId,
  respondInvalidCronParams,
  respondMissingCronJobId,
  respondCronJobNotFound,
  respondRefusedCronAgent,
  resolveCronScopedToolEditRefusal,
} from "./cron-job-access.js";
import { respondCronJobConfigRevisionConflict } from "./cron-revision-error.js";
import { withCronStreamExecApproval } from "./cron-stream-approval.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronUpdateHandler: GatewayRequestHandler = async ({
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
  const p = candidate;
  const callerScope = readCronCallerScope(client);
  const jobId = resolveCronJobId(p);
  if (!jobId) {
    respondMissingCronJobId(respond, "cron.update");
    return;
  }
  const patch: CronJobPatch = normalizedPatch;
  const reviewOnly = p.reviewModelPolicy === true && Object.keys(patch).length === 0;
  if (p.dryRun && !reviewOnly) {
    respondInvalidCronParams(
      respond,
      "cron.update",
      "dryRun requires reviewModelPolicy and an empty patch",
    );
    return;
  }
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
  if (!canHumanManageCronJob(client, currentJob)) {
    respondCronJobNotFound(respond, jobId);
    return;
  }
  let assertOwnerSelectionCurrent: (() => void) | undefined;
  try {
    assertOwnerSelectionCurrent = await prepareCronOwnerChange(client, currentJob, patch);
  } catch (error) {
    respondInvalidCronParams(respond, "cron.update", formatErrorMessage(error));
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
  // The native process is authorized by whoever approves it now; the payload keeps its requester.
  let processSource: OperatorRunRecoverySnapshot | undefined;
  let operatorSourceExecutionRevision: string | undefined;
  let streamExecPolicy: ReturnType<typeof resolveCronStreamExecPolicy>;
  const requiresStreamExec = cronUpdateRequiresStreamExecAuthority(patch, currentJob);
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
  let targetAccess: Awaited<ReturnType<typeof prepareHumanCronTargetAccess>>;
  const validateUpdate = async (jobToUpdate: CronStoredJob) => {
    assertHumanCronJobAccess(client, jobToUpdate);
    assertHumanCronExecutionAccess(client, jobToUpdate, patch);
    assertOwnerSelectionCurrent?.();
    assertCronModelJobAllowed(client, cfg, jobToUpdate, patch);
    const nextJob = await assertValidCronUpdatePatch({
      cfg,
      defaultAgentId: context.cron.getDefaultAgentId(),
      currentJob: jobToUpdate,
      patch,
    });
    targetAccess?.release();
    targetAccess = undefined;
    targetAccess = await prepareHumanCronTargetAccess(
      client,
      () => context.getRuntimeConfig(),
      jobToUpdate,
      nextJob,
      context.cron.getDefaultAgentId(),
    );
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
    streamExecPolicy = resolveCronStreamExecPolicy(client, requiresStreamExec, context);
    capture = reviewOnly ? undefined : resolveCronCreatorAuthorityCapture(creatorScope);
    const runtimeAuthority = capture?.captureRuntimeAuthority();
    capture &&= { ...capture, captureRuntimeAuthority: () => runtimeAuthority };
    const nextJob = await validateUpdate(currentJob);
    const nextSourceRevision = resolveCronOperatorExecutionRevision(nextJob);
    const sealed = currentJob.operatorSource;
    const sourceBound = Boolean(
      client?.internal?.openclawIdPrincipal ||
      sealed?.source.kind === "gateway" ||
      sealed?.source.snapshot.openclawIdPrincipal ||
      currentJob.streamOperatorSource,
    );
    if (
      !reviewOnly &&
      (creatorScope ||
        (sourceBound &&
          (requiresStreamExec ||
            patch.enabled === true ||
            sealed?.executionRevision !== nextSourceRevision)))
    ) {
      operatorSourceExecutionRevision = nextSourceRevision;
      operatorCapture = await captureCronCreatorSession(
        nextJob,
        creatorScope,
        { client, context, signal, hasCurrentClientAuthority },
        cfg,
        true,
      );
      processSource = operatorCapture.operatorSource?.snapshot;
      operatorCapture = retainCronControlSource({
        job: currentJob,
        patch,
        capture: operatorCapture,
        context,
      });
    }
    inference = runtimeAuthority
      ? undefined
      : await captureCronUpdatedInferenceBinding(
          nextJob,
          patch,
          cfg,
          {
            client,
            context,
            signal,
            hasCurrentClientAuthority,
          },
          { currentJob, explicit: p.reviewModelPolicy === true },
        );
  } catch (err) {
    operatorCapture?.disposeOperatorSource?.();
    targetAccess?.release();
    respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
    return;
  }
  const commitGuard = resolveCronMutationCommitGuard(
    client,
    context,
    { callerScope, jobId },
    {
      sessionMutationCommitGuard: () => {
        sessionMutationCommitGuard?.();
        assertOwnerSelectionCurrent?.();
        targetAccess?.assertCurrent();
        capture?.assertCurrent();
        inference?.assertInferenceSelectionCurrent();
        operatorCapture?.assertOperatorSourceCurrent?.();
      },
      hasCurrentClientAuthority,
      modelJobPolicy: { config: cfg, jobId, patch },
    },
  );
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
    ...(inference?.inferenceBinding !== undefined
      ? { inferenceBinding: inference.inferenceBinding }
      : {}),
    ...(inference?.inferenceGrants !== undefined
      ? { inferenceGrants: inference.inferenceGrants }
      : {}),
    commitGuard,
    ...(capture ? { captureRuntimeAuthority: capture.captureRuntimeAuthority } : {}),
  };
  let job: Awaited<ReturnType<typeof context.cron.update>>;
  try {
    if (reviewOnly) {
      const latest = await context.cron.readJob(jobId);
      if (!latest) {
        respondCronJobNotFound(respond, jobId);
        return;
      }
      const expected = p.expectedConfigRevision ?? resolveCronJobConfigRevision(currentJob);
      const actual = resolveCronJobConfigRevision(latest);
      if (actual !== expected) {
        throw new CronJobConfigRevisionConflictError(expected, actual);
      }
      commitGuard?.();
      const changed =
        inference?.inferenceGrants !== undefined &&
        !isDeepStrictEqual(
          currentJob.inferenceGrants === undefined ? undefined : { ...currentJob.inferenceGrants },
          { ...inference.inferenceGrants },
        );
      if (p.dryRun || !changed) {
        respond(
          true,
          {
            ...cronJobReadView(latest),
            modelPolicyReview: {
              dryRun: p.dryRun === true,
              changed,
              approvedCandidates: Object.keys(inference?.inferenceGrants ?? {}),
            },
            ...(inference?.inferenceWarning ? { warning: inference.inferenceWarning } : {}),
          },
          undefined,
        );
        return;
      }
    }
    if (
      requiresStreamExec &&
      !currentJob.streamSandbox &&
      !streamExecPolicy?.sandboxContext &&
      (currentJob.streamOperatorSource ||
        currentJob.operatorSource?.source.snapshot.openclawIdPrincipal ||
        processSource?.openclawIdPrincipal)
    ) {
      if (!processSource) {
        throw new TypeError(
          "Reauthorize this stream from a current authenticated Gateway operator.",
        );
      }
      updateOptions.streamOperatorSource = processSource;
    }
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
            const expectedConfigRevision =
              p.expectedConfigRevision ??
              (inference ? resolveCronJobConfigRevision(currentJob) : undefined);
            if (expectedConfigRevision !== undefined) {
              const actualConfigRevision = resolveCronJobConfigRevision(lockedJob);
              if (actualConfigRevision !== expectedConfigRevision) {
                throw new CronJobConfigRevisionConflictError(
                  expectedConfigRevision,
                  actualConfigRevision,
                );
              }
            }
            const lockedRequiresStreamExec = cronUpdateRequiresStreamExecAuthority(
              patch,
              lockedJob,
            );
            if (lockedRequiresStreamExec && !streamExecPolicy) {
              streamExecPolicy = resolveCronStreamExecPolicy(client, true, context);
            }
            const execPolicy = lockedRequiresStreamExec ? streamExecPolicy : undefined;
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
    operatorCapture?.disposeOperatorSource?.();
    targetAccess?.release();
    inference?.disposeInferenceAuthorization();
  }
  context.logGateway.info("cron: job updated", { jobId });
  respond(
    true,
    {
      ...cronJobReadView(job),
      ...(deliveryPreview ? { deliveryPreview } : {}),
      ...(inference?.inferenceWarning ? { warning: inference.inferenceWarning } : {}),
    },
    undefined,
  );
};
