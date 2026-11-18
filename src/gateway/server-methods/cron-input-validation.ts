import { randomUUID } from "node:crypto";
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { captureScheduledOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { attributeDelegatedSessionCreator } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveCronJobEffectiveAgentId,
  tryResolveCronJobEffectiveAgentId,
} from "../../cron/agent-id.js";
import {
  assertValidCronAnnounceDelivery,
  assertValidCronFailureAlert,
} from "../../cron/delivery-channel-validation.js";
import { resolveCronDeliveryDefaultsScope } from "../../cron/delivery-defaults.js";
import { resolveCronDeliveryPlan } from "../../cron/delivery-plan.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import {
  requiresExternalCronDelivery,
  resolveDeliveryTarget,
} from "../../cron/isolated-agent/delivery-target.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { resolveFailureAlert } from "../../cron/service/failure-alerts.js";
import { applyJobPatch } from "../../cron/service/jobs.js";
import {
  isCronOperatorSourceParent,
  resolveCronDeliverySessionKey,
  resolveCronSessionTargetSessionKey,
} from "../../cron/session-target.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoredJob } from "../../cron/types.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { readGatewayDeviceSourceAuthority } from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { CronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";

type InferenceCaller = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "hasCurrentClientAuthority"
> & {
  /** Native workflows may retain their authenticated requester without a creating conversation. */
  captureIndependentOperatorSource?: true;
};

/** Authorize explicitly authored personal accounts without recording a credential. */
export async function authorizeCronModelPin(
  job: Pick<CronJob, "payload">,
  caller: InferenceCaller,
): Promise<(() => void) | undefined> {
  if (job.payload.kind !== "agentTurn") {
    return undefined;
  }
  const { profile } = splitTrailingAuthProfile(job.payload.model ?? "");
  if (job.payload.modelRuntime && !profile) {
    throw new Error("A model runtime requires a model with an explicit @profile account.");
  }
  if (profile && isUserModelAuthProfileId(profile)) {
    return (await preparePersonalModelAccountSelection(caller, profile)).assertCurrent;
  }
  return undefined;
}

export function requiresExplicitAgentRuntimeToolsAllow(params: {
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

// Published clients send "deliver"; translate only the already-snapshotted request.
function normalizeCronRequestDeliveryMode(input: CronJobPatch | null): void {
  const delivery = input?.delivery;
  if (typeof delivery?.mode === "string" && delivery.mode.trim().toLowerCase() === "deliver") {
    delivery.mode = "announce";
  }
}

/** Validate authored fields before normalization can erase blank or invalid input. */
export function normalizeCronAddRequest(params: unknown): {
  candidate: unknown;
  enabledExplicit: boolean;
} {
  const rawParams = asOptionalObjectRecord(params);
  for (const key of ["declarationKey", "displayName"]) {
    const value = rawParams?.[key];
    if (typeof value === "string" && value.trim().length === 0) {
      throw new Error(`${key} must not be blank`);
    }
  }
  const hasEnabled = Boolean(rawParams && Object.hasOwn(rawParams, "enabled"));
  const parsedEnabled = hasEnabled ? parseBoolean(rawParams?.enabled) : undefined;
  if (hasEnabled && parsedEnabled === undefined) {
    throw new Error("enabled must be a boolean");
  }
  assertCronDeliveryInputNonBlankFields(rawParams?.delivery);
  const normalized = normalizeCronJobCreate(params, {
    sessionContext: { sessionKey: readStringField(rawParams, "sessionKey") },
  });
  normalizeCronRequestDeliveryMode(normalized);
  return {
    candidate: normalized ?? params,
    enabledExplicit: parsedEnabled !== undefined,
  };
}

export function normalizeCronUpdateRequest(params: unknown): {
  candidate: unknown;
  normalizedPatch: CronJobPatch | null;
} {
  const rawParams = asOptionalObjectRecord(params);
  const rawPatch = rawParams?.patch;
  const patchFields = asOptionalObjectRecord(rawPatch);
  const rawDisplayName = patchFields?.displayName;
  if (typeof rawDisplayName === "string" && rawDisplayName.trim().length === 0) {
    throw new Error("displayName must not be blank");
  }
  assertCronDeliveryInputNonBlankFields(patchFields?.delivery);
  const normalizedPatch = normalizeCronJobPatch(rawPatch);
  normalizeCronRequestDeliveryMode(normalizedPatch);
  return {
    candidate: normalizedPatch && rawParams ? { ...rawParams, patch: normalizedPatch } : params,
    normalizedPatch,
  };
}

export async function assertValidCronUpdatePatch(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  currentJob: CronStoredJob;
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
    await assertCronDoesNotTargetAgentHarness(nextJob, params.cfg);
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
  // Compare the canonical before/after policy so route-changing edits are
  // validated without blocking threshold-only edits on legacy stored channels.
  const failureAlertPatch = params.patch.failureAlert;
  const failureAlertRoutingPatched =
    failureAlertPatch &&
    ("channel" in failureAlertPatch || "to" in failureAlertPatch || "mode" in failureAlertPatch);
  const alertDeps = {
    deps: { cronConfig: params.cfg.cron, defaultAgentId: params.defaultAgentId },
  };
  const currentAlert = resolveFailureAlert(alertDeps, params.currentJob);
  const nextAlert = resolveFailureAlert(alertDeps, { ...nextJob, delivery: effectiveDelivery });
  const alertNewlyEnabled = currentAlert === null && nextAlert !== null;
  const alertRouteChanged =
    currentAlert?.mode !== nextAlert?.mode ||
    currentAlert?.channel !== nextAlert?.channel ||
    currentAlert?.to !== nextAlert?.to ||
    currentAlert?.accountId !== nextAlert?.accountId ||
    currentAlert?.threadId !== nextAlert?.threadId;
  if (
    failureAlertRoutingPatched ||
    alertNewlyEnabled ||
    (alertRouteChanged && (params.patch.delivery !== undefined || failureAlertPatch === null))
  ) {
    await assertValidCronFailureAlert({
      cfg: params.cfg,
      failureAlert: nextJob.failureAlert,
      delivery: effectiveDelivery,
      owner: nextJob,
      defaultAgentId: params.defaultAgentId,
    });
  }
  return nextJob;
}

export async function assertCronDoesNotTargetAgentHarness(
  input: {
    agentId?: string | null;
    sessionTarget?: string | null;
    sessionKey?: string | null;
  },
  cfg: OpenClawConfig,
): Promise<void> {
  const targetSessionKey =
    resolveCronSessionTargetSessionKey(input.sessionTarget) ??
    (input.sessionTarget === "current" ? input.sessionKey?.trim() : undefined);
  if (!targetSessionKey) {
    return;
  }

  const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg,
    key: targetSessionKey,
    agentId: input.agentId?.trim() || undefined,
  });
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

export async function captureCronCreatorSession(
  job: CronJobCreate & Partial<Pick<CronStoredJob, "operatorSource" | "streamOperatorSource">>,
  callerScope: CronCallerScope | undefined,
  caller: InferenceCaller,
  cfg: OpenClawConfig,
  hasRuntimeAuthority = false,
) {
  const inheritedAuthority = caller.client?.internal?.operatorRunAuthority;
  const hasConversationResult =
    job.sessionTarget !== "main" &&
    (job.payload.kind === "agentTurn" ||
      job.payload.kind === "script" ||
      job.payload.kind === "command");
  const sessionKey =
    callerScope?.sessionKey ?? (hasConversationResult ? job.sessionKey : undefined);
  const agentId = callerScope?.agentId ?? job.agentId;
  const loaded = sessionKey
    ? await loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: sessionKey, agentId })
    : undefined;
  const creatorSession = loaded?.entry;
  const sourceConversation =
    hasConversationResult && loaded && creatorSession?.sessionId
      ? {
          sessionKey: loaded.canonicalKey,
          sessionId: creatorSession.sessionId,
          lifecycleRevision: creatorSession.lifecycleRevision,
        }
      : undefined;
  // Operator-supplied sessions bind delivery only; agent callers inherit creator facts.
  const actor = callerScope
    ? creatorSession?.createdActor
    : resolveOperatorSessionCreation(caller.client).actor;
  const actorId = normalizeOptionalString(actor?.id);
  const legacyActor = actor ? { ...actor, ...(actorId ? { id: actorId } : {}) } : undefined;
  const createdActor = callerScope
    ? attributeDelegatedSessionCreator(
        legacyActor ??
          (callerScope.creatorProfileId ? { type: "agent", id: callerScope.agentId } : undefined),
        callerScope.creatorProfileId,
        callerScope.agentId,
      )
    : legacyActor;
  const assertInferenceSelectionCurrent = hasRuntimeAuthority
    ? undefined
    : await authorizeCronModelPin(job, caller);
  const directControlUi =
    caller.client?.internal?.authenticatedControlUi === true &&
    !caller.client.internal.syntheticClient &&
    !caller.client.internal.agentRuntimeIdentity &&
    !caller.client.internal.agentToolCaller &&
    Boolean(caller.client.connId) &&
    readGatewayDeviceSourceAuthority(caller.hasCurrentClientAuthority) !== undefined;
  const independent = Boolean(
    directControlUi ||
    caller.captureIndependentOperatorSource ||
    inheritedAuthority?.openclawIdPrincipal ||
    caller.client?.internal?.openclawIdPrincipal ||
    job.operatorSource?.source.kind === "gateway" ||
    job.operatorSource?.source.snapshot.openclawIdPrincipal ||
    job.streamOperatorSource,
  );
  let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
  try {
    if (!inheritedAuthority && independent) {
      if (!caller.hasCurrentClientAuthority) {
        throw new TypeError(
          "Current authenticated requester authority is required to reauthorize this automation.",
        );
      }
      captured = await captureGatewayOperatorRunAuthority({
        client: caller.client,
        context: caller.context,
        hasCurrentClientAuthority: caller.hasCurrentClientAuthority,
      });
    }
    const operatorAuthority = captured?.authority ?? inheritedAuthority;
    const parentLinked =
      callerScope &&
      loaded &&
      creatorSession &&
      isCronOperatorSourceParent(
        { sessionTarget: job.sessionTarget, sourceConversation },
        loaded.canonicalKey,
      );
    const legacyParent = parentLinked && caller.client?.internal?.agentRuntimeIdentity;
    const operatorSource =
      operatorAuthority &&
      operatorScopeSatisfied("operator.cron", operatorAuthority.scopes) &&
      (independent || (legacyParent && job.payload.kind === "agentTurn"))
        ? captureScheduledOperatorSource({
            authority: operatorAuthority,
            entry: creatorSession,
            agentId: independent
              ? (() => {
                  const selected = tryResolveCronJobEffectiveAgentId(
                    job,
                    caller.context.cron.getDefaultAgentId(),
                  );
                  if (!selected) {
                    throw new TypeError(
                      "The automation has no effective agent for its authenticated source.",
                    );
                  }
                  return selected;
                })()
              : (loaded?.agentId ??
                resolveCronJobEffectiveAgentId(
                  { ...job, agentId },
                  tryResolveAmbientOwnerAgentId(cfg),
                )),
            sessionKey: loaded?.canonicalKey,
            sourceRunId:
              caller.client?.internal?.agentRuntimeIdentity?.operationalRunInstance.runId ??
              randomUUID(),
            independent,
          })
        : undefined;
    if (independent && !operatorSource) {
      throw new TypeError(
        "This requester cannot retain the authenticated execution authority for the automation.",
      );
    }
    return {
      assertInferenceSelectionCurrent,
      ...(operatorSource ? { operatorSource } : {}),
      operatorSourceUnavailable: Boolean(
        parentLinked && operatorAuthority && job.payload.kind === "agentTurn" && !operatorSource,
      ),
      assertOperatorSourceCurrent: operatorSource ? operatorAuthority?.assertCurrent : undefined,
      disposeOperatorSource: captured?.release,
      ...(sourceConversation ? { sourceConversation } : {}),
      ...(createdActor ? { createdActor } : {}),
      ...(callerScope && creatorSession?.skillLibrarySelections
        ? { skillLibrarySelections: creatorSession.skillLibrarySelections }
        : {}),
    };
  } catch (error) {
    captured?.release();
    throw error;
  }
}

/** Waiting cannot finish while the caller owns the execution or result conversation lane. */
export async function cronRunQueuesBehindCaller(params: {
  job: CronStoredJob;
  cfg: OpenClawConfig;
  caller?: { agentId: string; sessionKey: string };
  resolveDefaultAgentId: () => string | undefined;
}): Promise<boolean> {
  const { job, cfg, caller } = params;
  if (!caller?.sessionKey) {
    return false;
  }
  if (job.sessionTarget === "main") {
    return true;
  }
  const agentId = normalizeAgentId(job.agentId ?? params.resolveDefaultAgentId());
  const isCallerSession = (sessionKey: string | undefined) => {
    if (sessionKey === undefined) {
      return false;
    }
    const targetKey =
      cfg.session?.scope === "global" && sessionKey.trim() === "global"
        ? "global"
        : resolveCronAgentSessionKey({
            sessionKey,
            agentId,
            mainKey: cfg.session?.mainKey,
            cfg,
          });
    // The literal global key identifies separate conversations for different agents.
    return (
      targetKey === caller.sessionKey &&
      (targetKey !== "global" || agentId === normalizeAgentId(caller.agentId))
    );
  };
  if (
    job.payload.kind === "agentTurn" &&
    isCallerSession(resolveCronSessionTargetSessionKey(job.sessionTarget))
  ) {
    return true;
  }
  const delivery = resolveCronDeliveryPlan(
    job,
    resolveCronDeliveryDefaultsScope(cfg.cron, job, params.resolveDefaultAgentId()),
  );
  if (!delivery.requested) {
    return false;
  }
  const sourceSessionKey = resolveCronDeliverySessionKey(job);
  try {
    const resolved = await resolveDeliveryTarget(
      cfg,
      agentId,
      {
        ...delivery,
        sessionTarget: job.sessionTarget,
        sourceConversation: job.sourceConversation,
        sessionKey: sourceSessionKey,
      },
      { dryRun: true },
    );
    if (resolved.ok) {
      return isCallerSession(resolved.sessionRoute?.sessionKey);
    }
    return !requiresExternalCronDelivery(delivery, resolved) && isCallerSession(sourceSessionKey);
  } catch {
    // The run is already enqueued; uncertain routing must not hold its caller's lane.
    return true;
  }
}
