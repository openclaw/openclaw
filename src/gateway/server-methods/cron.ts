// Gateway RPC handlers for cron job CRUD, run logs, wake, and delivery previews.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type CronListParams,
  ErrorCodes,
  errorShape,
  validateCronAddParams,
  validateCronGetParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronScratchGetParams,
  validateCronScratchSetParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { bindCronSelfRemovalCommitGuard } from "../../cron/active-jobs.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import {
  resolveCronDeliveryPreview,
  resolveCronDeliveryPreviews,
} from "../../cron/delivery-preview.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { resolveCronJobBoundSessionKeys } from "../../cron/job-session-bindings.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import type { CronListPageResult } from "../../cron/service/list-page-types.js";
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
  type CronCallerScope,
} from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronHistoryHandler } from "./cron-history.js";
import {
  assertValidCronUpdatePatch,
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
import { startCronListDiagnostics } from "./cron-list-diagnostics.js";
import { compactCronListJob } from "./cron-list-projection.js";
import { cronRunsHandler } from "./cron-runs.js";
import {
  createCronSessionVisibility,
  cronJobIsVisible,
  cronJobVisibilityTarget,
} from "./cron-visibility.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class CronJobConfigRevisionConflictError extends Error {
  constructor(
    readonly expectedConfigRevision: string,
    readonly actualConfigRevision: string,
  ) {
    super("cron job definition no longer matches the loaded version");
  }
}

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

function cronAddPayloadWithDeliveryPreview(params: {
  result: CronJob | { created: boolean; updated?: boolean; job: CronJob };
  deliveryPreview: CronDeliveryPreview;
}) {
  const job = "job" in params.result ? params.result.job : params.result;
  if ("job" in params.result) {
    return {
      created: params.result.created,
      ...(params.result.updated === undefined ? {} : { updated: params.result.updated }),
      job: cronJobReadView(job),
      deliveryPreview: params.deliveryPreview,
    };
  }
  return {
    ...cronJobReadView(job),
    deliveryPreview: params.deliveryPreview,
  };
}

function requiresExplicitAgentRuntimeToolsAllow(params: {
  job: Pick<CronJob, "payload" | "trigger">;
  callerScope: CronCallerScope | undefined;
}): boolean {
  return (
    params.callerScope !== undefined &&
    !params.callerScope.manageAll &&
    cronJobUsesToolRuntime(params.job) &&
    params.job.payload.toolsAllow === undefined
  );
}

function cronPatchTouchesToolRuntime(patch: CronJobPatch): boolean {
  return patch.payload !== undefined || Object.hasOwn(patch, "trigger");
}

/** Gateway request handlers for cron jobs and cron run-log access. */
export const cronHandlers: GatewayRequestHandlers = {
  wake: async ({ params, respond, context, client }) => {
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
    assertActiveAgentRuntimeAuthority(client, context);
    const result = context.cron.wake({
      mode: p.mode,
      text: p.text,
      ...(sessionKey ? { sessionKey } : {}),
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    });
    respond(true, result, undefined);
  },
  "cron.list": async (options) => {
    const { params, respond: originalRespond, context, client } = options;
    const diagnostics = startCronListDiagnostics(context.logGateway, originalRespond);
    const respond = diagnostics?.respond ?? originalRespond;
    const visibilityRead = createCronSessionVisibility(client, () => context.getRuntimeConfig());
    let handlerOutcome: "returned" | "threw" = "returned";
    try {
      if (!assertValidParams(params, validateCronListParams, "cron.list", respond)) {
        return;
      }
      const p = params as CronListParams;
      const admittedScope = readCronCallerScope(client);
      const callerScope = admittedScope?.manageAll ? undefined : admittedScope;
      const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
      if (callerScope && requestedAgentId && requestedAgentId !== callerScope.agentId) {
        respondInvalidCronParams(respond, "cron.list", "agentId outside caller scope");
        return;
      }
      const listOptions = {
        includeDisabled: p.includeDisabled,
        limit: p.limit,
        offset: p.offset,
        query: p.query,
        enabled: p.enabled,
        scheduleKind: p.scheduleKind,
        lastRunStatus: p.lastRunStatus,
        trigger: p.trigger,
        sortBy: p.sortBy,
        sortDir: p.sortDir,
        // Owners retain visibility when execution is retargeted to another agent.
        agentId: callerScope ? undefined : p.agentId,
      };
      const matchesRequestScope = (job: CronJob) => {
        const scope = readCronCallerScope(client);
        const currentScope = scope?.manageAll ? undefined : scope;
        const currentDefault = context.cron.getDefaultAgentId();
        return (
          cronJobMatchesCallerScope({
            job,
            callerScope: currentScope,
            defaultAgentId: currentDefault,
            allowCurrentJob: true,
          }) &&
          (!p.sessionKey ||
            (resolveCronJobBoundSessionKeys(job, {
              cfg: context.getRuntimeConfig(),
              defaultAgentId: currentDefault,
            }).has(p.sessionKey) &&
              (parseAgentSessionKey(p.sessionKey) !== null ||
                !p.sessionAgentId ||
                normalizeAgentId(job.owner?.agentId ?? currentDefault) ===
                  normalizeAgentId(p.sessionAgentId))))
        );
      };
      if (visibilityRead.resolve()) {
        const loadedJobs: CronJob[] = [];
        // The list owner applies every authored filter before sharing preparation.
        await context.cron.listPage(listOptions, (job) => {
          if (matchesRequestScope(job)) {
            loadedJobs.push(job);
          }
          return false;
        });
        assertCronReadCurrent(options);
        await visibilityRead.prepare(
          loadedJobs.map((job) => cronJobVisibilityTarget(job, context.cron.getDefaultAgentId())),
        );
      }
      assertCronReadCurrent(options);
      const cronVisibility = visibilityRead.resolve();
      const defaultAgentId = context.cron.getDefaultAgentId();
      diagnostics?.setRequestMode({
        compact: p.compact === true,
        previewsRequested: p.compact !== true && p.includeDeliveryPreviews !== false,
        scopeApplied: Boolean(callerScope || cronVisibility),
      });
      diagnostics?.mark("listing");
      const selectedJobIds = new Set<string>();
      const matchesCurrentJob = (job: CronJob) =>
        matchesRequestScope(job) &&
        cronJobIsVisible(job, visibilityRead.resolve(), context.cron.getDefaultAgentId());
      const assertPageCurrent = () => {
        assertCronReadCurrent(options);
        const currentScope = readCronCallerScope(client);
        // The filtered total belongs to this scope, even when its visible page is empty.
        if (
          Boolean(currentScope && !currentScope.manageAll) !== Boolean(callerScope) ||
          Boolean(visibilityRead.resolve()) !== Boolean(cronVisibility)
        ) {
          throw new Error("Cron list visibility changed; refresh the page");
        }
        for (const id of selectedJobIds) {
          const current = context.cron.getJob(id);
          if (!current || !matchesCurrentJob(current)) {
            throw new Error("Cron list visibility changed; refresh the page");
          }
        }
      };
      let matchesJob: ((job: CronJob) => boolean) | undefined;
      if (callerScope || cronVisibility || p.sessionKey) {
        diagnostics?.startScopeAttempt();
        matchesJob = (job) => {
          const matched = matchesCurrentJob(job);
          if (matched) {
            selectedJobIds.add(job.id);
          }
          return matched;
        };
      }
      let page: CronListPageResult;
      const finishPage = diagnostics?.startSourcePage();
      try {
        page = await context.cron.listPage(listOptions, matchesJob);
      } finally {
        finishPage?.();
      }
      if (matchesJob) {
        for (const job of page.jobs) {
          selectedJobIds.add(job.id);
        }
      }
      assertPageCurrent();
      diagnostics?.setReturnedCount(page.jobs.length);
      diagnostics?.mark("projection");
      const jobs = page.jobs.map((job) => ({
        ...(p.compact === true ? compactCronListJob(job) : cronJobReadView(job)),
        effectiveAgentId: tryResolveCronJobEffectiveAgentId(job, defaultAgentId) ?? null,
      }));
      if (p.compact === true) {
        respond(true, { ...page, jobs }, undefined);
        return;
      }
      if (p.includeDeliveryPreviews === false) {
        // Full job rows are the default because editors need their payloads. Delivery
        // previews are independently suppressible so list-only callers avoid per-job I/O
        // without weakening the shipped full-response default.
        respond(true, { ...page, jobs }, undefined);
        return;
      }
      diagnostics?.mark("previews");
      const deliveryPreviews = await resolveCronDeliveryPreviews({
        cfg: context.getRuntimeConfig(),
        defaultAgentId: context.cron.getDefaultAgentId(),
        jobs: page.jobs,
      });
      assertPageCurrent();
      respond(true, { ...page, jobs, deliveryPreviews }, undefined);
    } catch (error) {
      handlerOutcome = "threw";
      throw error;
    } finally {
      visibilityRead.release();
      diagnostics?.finish(handlerOutcome);
    }
  },
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
  "cron.scratch.get": scopedCronJobHandler(
    "cron.scratch.get",
    validateCronScratchGetParams,
    async ({ respond, context }, { jobId }) => {
      const state = await context.cron.readScratch(jobId);
      respond(
        true,
        {
          scratch: publicCronScratch(state.scratch),
          currentRevision: state.currentRevision,
          maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
        },
        undefined,
      );
    },
  ),
  "cron.scratch.set": scopedCronJobHandler(
    "cron.scratch.set",
    validateCronScratchSetParams,
    async (
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope },
    ) => {
      const p = params;
      try {
        const commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const result = await context.cron.writeScratch(jobId, {
          content: p.content,
          expectedRevision: p.expectedRevision,
          ...(commitGuard ? { commitGuard } : {}),
        });
        if (!result.ok) {
          respond(true, result, undefined);
          return;
        }
        respond(
          true,
          {
            ok: true,
            scratch: publicCronScratch(result.scratch),
            currentRevision: result.currentRevision,
            maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
          },
          undefined,
        );
      } catch (error) {
        respondInvalidCronParams(respond, "cron.scratch.set", formatErrorMessage(error));
      }
    },
  ),
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
    const operatorActor = callerScope ? undefined : resolveOperatorSessionCreation(client).actor;
    const creatorSession = callerScope?.sessionKey
      ? loadGatewaySessionEntryReadOnly(callerScope.sessionKey, {
          agentId: callerScope.agentId,
        }).entry
      : undefined;
    // Agent-tool clients own one exact signed session. Read that session's creator instead of
    // reclassifying spawn context as the automation creator; params never carry this provenance.
    const actor = operatorActor ?? creatorSession?.createdActor;
    const actorId = normalizeOptionalString(actor?.id);
    const createdActor = actor ? { ...actor, ...(actorId ? { id: actorId } : {}) } : undefined;
    let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
    try {
      captureRuntimeAuthority = resolveCronCreatorAuthorityCapture(callerScope);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    const assertMutationCurrent = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    });
    const selectionIdentity = JSON.stringify(creatorSession?.skillLibrarySelections);
    const commitGuard = () => {
      assertMutationCurrent?.();
      if (creatorSession && callerScope?.sessionKey) {
        const latest = loadGatewaySessionEntryReadOnly(callerScope.sessionKey, {
          agentId: callerScope.agentId,
        }).entry;
        if (
          latest?.sessionId !== creatorSession.sessionId ||
          latest.lifecycleRevision !== creatorSession.lifecycleRevision ||
          JSON.stringify(latest.skillLibrarySelections) !== selectionIdentity
        ) {
          throw new Error(
            "Creator session changed before scheduling; retry from the current turn.",
          );
        }
      }
    };
    const jobCreate = applyCronCreateCallerScopeDefault(candidate as CronJobCreate, callerScope);
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
    try {
      assertCronDoesNotTargetAgentHarness(jobCreate);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    try {
      await assertValidCronCreateDelivery(cfg, jobCreate);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    // Resolve before the durable add. A preview failure after commit would make a safe retry
    // create a duplicate job.
    const deliveryPreview = await resolveCronDeliveryPreview({
      cfg,
      defaultAgentId: context.cron.getDefaultAgentId(),
      job: jobCreate,
    });
    let result: Awaited<ReturnType<typeof context.cron.add>>;
    try {
      result = await context.cron.add(jobCreate, {
        enabledExplicit,
        ...(createdActor ? { createdActor } : {}),
        ...(creatorSession?.skillLibrarySelections
          ? { skillLibrarySelections: creatorSession.skillLibrarySelections }
          : {}),
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
      cronAddPayloadWithDeliveryPreview({
        result,
        deliveryPreview,
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
    try {
      captureRuntimeAuthority = resolveCronCreatorAuthorityCapture(callerScope);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const commitGuard = resolveCronMutationCommitGuard(client, context, undefined, {
      sessionMutationCommitGuard,
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
    const touchesToolRuntime = cronPatchTouchesToolRuntime(patch);
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
          await validateUpdate(lockedJob);
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
    respond(true, cronJobReadView(job), undefined);
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
        if (error instanceof TypeError) {
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
    async (
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope },
    ) => {
      const p = params;
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
      respond(true, { ...result, processInstanceId: getGatewayProcessInstanceId() }, undefined);
    },
  ),
  "cron.history": cronHistoryHandler,
  "cron.runs": cronRunsHandler,
};

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
for (const [method, handler] of Object.entries(cronHandlers)) {
  cronHandlers[method] = async (args) => {
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
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
