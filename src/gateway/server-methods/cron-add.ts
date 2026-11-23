import { randomUUID } from "node:crypto";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
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
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
  assertValidCronSessionTarget,
} from "./cron-input-validation.js";
import { respondInvalidCronParams, respondRefusedCronAgent } from "./cron-job-access.js";
import { withCronStreamExecApproval } from "./cron-stream-approval.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

// A title is optional. Share one short budget across setup and both model attempts.
const CRON_ADD_NAMING_TIMEOUT_MS = 5_000;

export const cronAddHandler: GatewayRequestHandler = async ({
  params: rawParams,
  respond,
  context,
  client,
  signal,
  sessionMutationCommitGuard,
  hasCurrentClientAuthority,
}) => {
  sessionMutationCommitGuard?.();
  const commandCreation = readPluginCommandCreation(rawParams);
  const params = commandCreation.params;
  // Normalization fills a missing name from the prompt's first line; a model name replaces it below.
  const rawName = asOptionalObjectRecord(params)?.name;
  const nameProvided = typeof rawName === "string" && rawName.trim().length > 0;
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
  let namingAuthority: AdmittedRunOperatorAuthority | undefined;
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
      {
        client,
        context,
        signal,
        hasCurrentClientAuthority,
        onOperatorAuthority: (authority) => {
          namingAuthority = authority;
        },
      },
      cfg,
      runtimeAuthority !== undefined,
    );
    await assertValidCronSessionTarget(jobCreate, cfg);
    await assertValidCronCreateDelivery(
      cfg,
      { ...jobCreate, createdActor: creatorOptions.createdActor },
      context.cron.getDefaultAgentId(),
    );
  } catch (err) {
    creatorOptions?.disposeOperatorSource?.();
    creatorOptions?.disposeInferenceAuthorization?.();
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  const namingAgentId = tryResolveCronJobEffectiveAgentId(
    jobCreate,
    context.cron.getDefaultAgentId(),
  );
  const namingSource =
    jobCreate.payload.kind === "agentTurn"
      ? jobCreate.payload.message
      : jobCreate.payload.kind === "systemEvent"
        ? jobCreate.payload.text
        : undefined;
  // Only the interactive editor requests model naming. Other callers keep the
  // deterministic name without disclosing the prompt to a title provider.
  if (
    !nameProvided &&
    client?.internal?.authenticatedControlUi &&
    !callerScope &&
    !jobCreate.declarationKey &&
    namingAgentId &&
    namingSource &&
    namingAuthority
  ) {
    const operatorAuthority = namingAuthority;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), CRON_ADD_NAMING_TIMEOUT_MS);
    const namingSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const name = await racePromiseWithAbortSignal(async () => {
        const { generateAutomationName } = await import("../dashboard-session-title.js");
        namingSignal.throwIfAborted();
        return generateAutomationName({
          cfg,
          agentId: namingAgentId,
          message: namingSource,
          abortSignal: namingSignal,
          operatorAuthority,
        });
      }, namingSignal);
      if (name) {
        jobCreate.name = name;
      }
    } catch {
      // Naming is best effort: keep the prompt-derived name.
    } finally {
      clearTimeout(timer);
    }
  }
  // Resolve the preview before durable add so a preview failure cannot duplicate a retry.
  const previewContext = { cfg, defaultAgentId: context.cron.getDefaultAgentId() };
  let deliveryPreview: CronDeliveryPreview | undefined;
  let result: Awaited<ReturnType<typeof context.cron.add>>;
  try {
    deliveryPreview = await resolveCronDeliveryPreview({
      ...previewContext,
      job: {
        ...jobCreate,
        sourceConversation: creatorOptions.sourceConversation,
        createdActor: creatorOptions.createdActor,
      },
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
          ...(jobCreate.schedule.kind === "stream" &&
          !streamSandbox &&
          creatorOptions?.operatorSource?.snapshot.openclawIdPrincipal
            ? { streamOperatorSource: creatorOptions.operatorSource.snapshot }
            : {}),
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
    creatorOptions.disposeOperatorSource?.();
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
    {
      ...cronAddResultReadView({
        result,
        deliveryPreview:
          "job" in result && !result.created
            ? await resolveCronDeliveryPreview({ ...previewContext, job })
            : deliveryPreview,
      }),
      ...(creatorOptions?.operatorSourceUnavailable && !job.operatorSource
        ? {
            warning:
              "This automation cannot retain the initiating operator grant. Protected operator actions require an interactive turn; its ingress owner must support principal recovery to run them unattended.",
          }
        : {}),
    },
    undefined,
  );
};
