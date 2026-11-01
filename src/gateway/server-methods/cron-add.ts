import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureCronStreamSandboxTarget } from "../../agents/sandbox/stream-context.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { resolveCronDeliveryPreview } from "../../cron/delivery-preview.js";
import { cronAddResultReadView } from "../../cron/job-read-view.js";
import { readPluginCommandCreation } from "../../cron/plugin-command-creation.js";
import { CronStreamApprovalEndedError } from "../../cron/stream-approval-outcome.js";
import { cronCreateRequiresStreamExecAuthority } from "../../cron/stream-exec-authority.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type { CronDeliveryPreview, CronJobCreate } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  applyCronCreateCallerScopeDefault,
  assertCronModelJobAllowed,
  cronCreateMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
  resolveCronStreamExecPolicy,
  resolveCronMutationCommitGuard,
  resolveCronScheduledToolPolicyForCaller,
} from "./cron-caller-scope.js";
import { prepareCronCreatorSession } from "./cron-creator-session.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import {
  captureCronCreatorSession,
  requiresExplicitAgentRuntimeToolsAllow,
  normalizeCronAddRequest,
  assertCronDoesNotTargetAgentHarness,
} from "./cron-input-validation.js";
import { respondInvalidCronParams, respondRefusedCronAgent } from "./cron-job-access.js";
import { withCronStreamExecApproval } from "./cron-stream-approval.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronAddHandler: GatewayRequestHandler = async ({
  params: rawParams,
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
  const commandCreation = readPluginCommandCreation(rawParams);
  const params = commandCreation.params;
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
  // SAFETY: cron.add validates this shape; createJob normalizes its nullable selectors.
  const jobCreate = applyCronCreateCallerScopeDefault(candidate as CronJobCreate, callerScope);
  const cfg = context.getRuntimeConfig();
  const creator = await prepareCronCreatorSession({
    context,
    client,
    callerScope,
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
    retainExecutionPolicy: cronCreateRequiresStreamExecAuthority(candidate),
  });
  if (commandCreation.creation) {
    const envelope = commandCreation.creation.envelope;
    const identity = client?.internal?.agentRuntimeIdentity;
    const parent = creator.session;
    if (
      !identity ||
      identity.agentId !== envelope.parent.agentId ||
      identity.sessionKey !== envelope.parent.sessionKey ||
      identity.operationalRunInstance.runId !== envelope.sourceRunId ||
      parent?.agentId !== envelope.parent.agentId ||
      parent.sessionKey !== envelope.parent.sessionKey ||
      parent.entry.sessionId !== envelope.parent.sessionId ||
      parent.entry.lifecycleRevision !== envelope.parent.lifecycleRevision
    ) {
      throw new Error("Scheduled command creator does not match its admitted parent incarnation.");
    }
  }
  let execPolicy: ReturnType<typeof resolveCronStreamExecPolicy>;
  let capture: ReturnType<typeof resolveCronCreatorAuthorityCapture>;
  try {
    assertCronModelJobAllowed(client, cfg, jobCreate);
    capture = resolveCronCreatorAuthorityCapture(callerScope);
    execPolicy = resolveCronStreamExecPolicy(
      client,
      cronCreateRequiresStreamExecAuthority(candidate),
      context,
    );
    if (execPolicy && !jobCreate.id) {
      jobCreate.id = randomUUID();
    }
  } catch (err) {
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  const assertMutationCurrent = resolveCronMutationCommitGuard(client, context, undefined, {
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  });
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
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
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
  let creatorOptions: Awaited<ReturnType<typeof captureCronCreatorSession>> | undefined;
  const commitGuard = () => {
    commandCreation.creation?.assertCurrent();
    assertMutationCurrent?.();
    capture?.assertCurrent();
    creatorOptions?.assertInferenceSelectionCurrent?.();
    assertCronModelJobAllowed(client, cfg, jobCreate);
    creatorOptions?.assertOperatorSourceCurrent?.();
    creator.assertCurrent();
    execPolicy?.assertCurrentSource?.();
  };
  try {
    // Consume once, then retain the result and its current-authority guard through commit.
    const runtimeAuthority = capture?.captureRuntimeAuthority();
    capture &&= { ...capture, captureRuntimeAuthority: () => runtimeAuthority };
    creatorOptions = await captureCronCreatorSession(
      jobCreate,
      callerScope,
      { client, context, signal },
      cfg,
      runtimeAuthority !== undefined,
    );
    await assertCronDoesNotTargetAgentHarness(jobCreate, cfg);
    await assertValidCronCreateDelivery(cfg, jobCreate);
  } catch (err) {
    creatorOptions?.disposeInferenceAuthorization?.();
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  // Resolve the preview before durable add so a preview failure cannot duplicate a retry.
  const previewContext = { cfg, defaultAgentId: context.cron.getDefaultAgentId() };
  let deliveryPreview: CronDeliveryPreview | undefined;
  let result: Awaited<ReturnType<typeof context.cron.add>>;
  try {
    deliveryPreview = await resolveCronDeliveryPreview({
      ...previewContext,
      job: { ...jobCreate, sourceConversation: creatorOptions.sourceConversation },
    });
    const streamSandbox = execPolicy?.sandboxContext
      ? (() => {
          if (!creator.session) {
            throw new TypeError("A sandbox stream requires its current creator session.");
          }
          return captureCronStreamSandboxTarget({
            sandbox: execPolicy.sandboxContext,
            ...creator.session,
          });
        })()
      : undefined;
    result = await withCronStreamExecApproval({
      context,
      client,
      creatorSessionId: creator.session?.entry.sessionId,
      sandboxContext: execPolicy?.sandboxContext,
      assertCurrent: commitGuard,
      onApprovalCommitted: execPolicy?.onApprovalCommitted,
      mutate: (streamExecApproval) =>
        context.cron.add(jobCreate, {
          streamExecApproval,
          streamSandbox,
          execPolicy,
          sessionEntryCurrent: creator.sessionEntryCurrent,

          enabledExplicit,
          ...creatorOptions,
          ...(commandCreation.creation
            ? {
                pluginCommand: commandCreation.creation.envelope,
                pluginCommandSourceDigest: commandCreation.creation.sourceDigest,
              }
            : {}),
          commitGuard,
          ...(capture ? { captureRuntimeAuthority: capture.captureRuntimeAuthority } : {}),
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
        }),
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
    if (
      !(err instanceof TypeError) &&
      !(err instanceof RangeError) &&
      !isCronInvalidRequestError(err)
    ) {
      throw err;
    }
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  } finally {
    creatorOptions.disposeInferenceAuthorization?.();
  }
  const job = "job" in result ? result.job : result;
  commandCreation.creation?.record(job);
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
};
