import { randomUUID } from "node:crypto";
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../../agents/auth-profiles/authorization-contract.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { captureScheduledOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { resolveSimpleCompletionSelectionForAgent } from "../../agents/simple-completion-selection.js";
import { attributeDelegatedSessionCreator } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import {
  assertValidCronAnnounceDelivery,
  assertValidCronFailureAlert,
} from "../../cron/delivery-channel-validation.js";
import { resolveCronDeliveryDefaultsScope } from "../../cron/delivery-defaults.js";
import { resolveCronDeliveryPlan } from "../../cron/delivery-plan.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import type { CronInferenceAccount, CronInferenceBinding } from "../../cron/inference-binding.js";
import {
  acquireCronInferenceAuthorization,
  captureCronFallbackInferenceAccounts,
  captureCronInferenceBinding,
} from "../../cron/inference-binding.runtime.js";
import {
  requiresExternalCronDelivery,
  resolveDeliveryTarget,
} from "../../cron/isolated-agent/delivery-target.js";
import { resolveCarriedCronModelSelection } from "../../cron/isolated-agent/session-carried-model.js";
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
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveHookExternalContentSource } from "../../security/external-content-source.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { CronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";

type InferenceCaller = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "hasCurrentClientAuthority"
>;

/**
 * The entry a job's cron session takes its runtime override from: the target row of a
 * `session:` job, or what a `current` job carries from its creating conversation.
 */
async function loadCronRuntimeSessionEntry(params: {
  cfg: OpenClawConfig;
  job: Pick<CronJob, "sessionTarget" | "sessionKey">;
  agentId?: string;
  executionEntry?: SessionEntry;
  loaded?: { key: string; entry?: SessionEntry };
}): Promise<Partial<SessionEntry> | undefined> {
  if (params.executionEntry) {
    return params.executionEntry;
  }
  const sourceKey =
    params.job.sessionTarget === "current" ? params.job.sessionKey?.trim() : undefined;
  if (!sourceKey) {
    return undefined;
  }
  const source =
    params.loaded?.key === sourceKey
      ? params.loaded.entry
      : (
          await loadGatewaySessionEntryReadOnlyInWorker({
            cfg: params.cfg,
            key: sourceKey,
            agentId: params.agentId,
          })
        )?.entry;
  return source ? resolveCarriedCronModelSelection(source) : undefined;
}

const log = createSubsystemLogger("cron");

/** New personal selections require the same live human authority as chat. */
function createPersonalAccountAuthorizer(caller: InferenceCaller) {
  const selections: UserModelAccountSelection[] = [];
  return {
    // Trusted creator selections already carry their owner's permission.
    authorizeProfile: async (profileId: string, inherited: boolean) => {
      if (isUserModelAuthProfileId(profileId) && !inherited) {
        const selection = await preparePersonalModelAccountSelection(caller, profileId);
        selections.push(selection);
        return selection.assertCurrent;
      }
      return undefined;
    },
    assertCurrent: () => {
      for (const selection of selections) {
        selection.assertCurrent();
      }
    },
  };
}

/** Each fallback provider runs only on an account recorded now, never one resolved later. */
async function withRecordedFallbackAccounts(
  binding: CronInferenceBinding,
  params: Omit<Parameters<typeof captureCronFallbackInferenceAccounts>[0], "primaryProvider">,
): Promise<CronInferenceBinding> {
  const { accounts, unrecorded } = await captureCronFallbackInferenceAccounts({
    ...params,
    primaryProvider: binding.provider,
  });
  for (const fallback of unrecorded) {
    log.warn(
      `automation fallback ${fallback.model} has no recorded inference account and will be refused: ${fallback.reason}`,
    );
  }
  const { fallbackAccounts: _previous, ...primary } = binding;
  return { ...primary, ...(accounts.length ? { fallbackAccounts: accounts } : {}) };
}

async function captureCronInferenceForCaller(
  params: Parameters<typeof captureCronInferenceBinding>[0] & {
    /** The job's payload fallbacks; omitted fallbacks inherit the agent policy. */
    fallbacks?: string[];
    recordedFallbackAccounts?: CronInferenceAccount[];
    fallbacksSubmitted?: boolean;
  },
  caller: InferenceCaller,
) {
  const personal = createPersonalAccountAuthorizer(caller);
  let authority: AuthProfileAuthorization | undefined;
  const { fallbacks, recordedFallbackAccounts, fallbacksSubmitted, ...captureParams } = params;
  let inferenceBinding = await captureCronInferenceBinding({
    ...captureParams,
    retainAuthorization: (captured) => {
      authority = captured;
    },
    authorizeProfile: personal.authorizeProfile,
  });
  if (inferenceBinding) {
    try {
      inferenceBinding = await withRecordedFallbackAccounts(inferenceBinding, {
        cfg: params.cfg,
        agentId: params.agentId,
        model: params.model,
        fallbacks,
        isGmailHook: params.isGmailHook,
        executionSessionEntry: params.executionSessionEntry,
        runtimeSessionEntry: params.runtimeSessionEntry,
        recordedAccounts: recordedFallbackAccounts,
        fallbacksSubmitted,
        authorizeProfile: personal.authorizeProfile,
      });
    } catch (error) {
      authority?.dispose();
      throw error;
    }
  }
  return {
    inferenceBinding,
    assertInferenceSelectionCurrent: () => {
      personal.assertCurrent();
      authority?.assertCurrent();
    },
    disposeInferenceAuthorization: () => authority?.dispose(),
  };
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
        legacyActor,
        callerScope.creatorProfileId,
        callerScope.agentId,
      )
    : legacyActor;
  const executionSessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? "";
  const executionSession =
    !hasRuntimeAuthority && job.payload.kind === "agentTurn" && executionSessionKey
      ? await loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: executionSessionKey, agentId })
      : undefined;
  const runtimeSessionEntry =
    !hasRuntimeAuthority && job.payload.kind === "agentTurn"
      ? await loadCronRuntimeSessionEntry({
          cfg,
          job,
          agentId,
          executionEntry: executionSession?.entry,
          loaded: sessionKey ? { key: sessionKey, entry: loaded?.entry } : undefined,
        })
      : undefined;
  const inference =
    // A creator runtime grant owns its own inference identity. Never bind an ambient host profile.
    !hasRuntimeAuthority && job.payload.kind === "agentTurn" && job.sessionTarget !== "main"
      ? await captureCronInferenceForCaller(
          {
            cfg,
            agentId: agentId ?? resolveDefaultAgentId(cfg),
            model: job.payload.model,
            isGmailHook:
              (job.payload.externalContentSource ??
                resolveHookExternalContentSource(
                  parseAgentSessionKey(executionSessionKey)?.rest ?? executionSessionKey,
                )) === "gmail",
            sessionEntry: callerScope ? creatorSession : undefined,
            executionSessionEntry: executionSession?.entry,
            runtimeSessionEntry,
            fallbacks: job.payload.fallbacks,
          },
          caller,
        )
      : undefined;
  const independent = Boolean(
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
              : (loaded?.agentId ?? agentId ?? resolveDefaultAgentId(cfg)),
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
      ...inference,
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
    inference?.disposeInferenceAuthorization();
    throw error;
  }
}

/** Keep the recorded primary account and record accounts for the job's current fallback chain. */
async function refreshRecordedFallbackAccounts(
  nextJob: CronStoredJob,
  binding: CronInferenceBinding,
  cfg: OpenClawConfig,
  agentId: string,
  caller: InferenceCaller,
  fallbacksSubmitted: boolean,
) {
  if (nextJob.payload.kind !== "agentTurn") {
    return undefined;
  }
  const executionKey = resolveCronSessionTargetSessionKey(nextJob.sessionTarget);
  const executionEntry = executionKey
    ? (await loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: executionKey, agentId }))?.entry
    : undefined;
  const personal = createPersonalAccountAuthorizer(caller);
  return {
    inferenceBinding: await withRecordedFallbackAccounts(binding, {
      cfg,
      agentId,
      model: nextJob.payload.model,
      fallbacks: nextJob.payload.fallbacks,
      isGmailHook: nextJob.payload.externalContentSource === "gmail",
      executionSessionEntry: executionEntry,
      runtimeSessionEntry: await loadCronRuntimeSessionEntry({
        cfg,
        job: nextJob,
        agentId,
        executionEntry,
      }),
      recordedAccounts: binding.fallbackAccounts,
      fallbacksSubmitted,
      authorizeProfile: personal.authorizeProfile,
    }),
    assertInferenceSelectionCurrent: personal.assertCurrent,
    disposeInferenceAuthorization: () => {},
  };
}

/** Only an explicitly selected account changes an existing job’s inference ownership. */
export async function captureCronUpdatedInferenceBinding(
  nextJob: CronStoredJob,
  patch: CronJobPatch,
  cfg: OpenClawConfig,
  caller: InferenceCaller,
) {
  if (nextJob.runtimeAuthority !== undefined || nextJob.payload.kind !== "agentTurn") {
    return undefined;
  }
  const model = patch.payload && "model" in patch.payload ? patch.payload.model : undefined;
  const agentId = nextJob.agentId ?? resolveDefaultAgentId(cfg);
  const fallbacks = nextJob.payload.fallbacks;
  const selection = model
    ? resolveSimpleCompletionSelectionForAgent({ cfg, agentId, modelRef: model })
    : null;
  // Native capture validates the actual execution route before authorizing a clear;
  // other empty captures must never release an existing stored account.
  const cliExecution = selection
    ? resolveCliRuntimeExecutionProvider({
        cfg,
        agentId,
        provider: selection.provider,
        modelId: selection.modelId,
        authProfileId: selection.profileId,
      })
    : undefined;
  if (!model || !selection?.profileId) {
    if (patch.agentId !== undefined && nextJob.inferenceBinding) {
      // A move may keep the account only when the new agent sees the same credential owner.
      const authority = await acquireCronInferenceAuthorization({
        binding: nextJob.inferenceBinding,
        cfg,
        agentDir: resolveAgentDir(cfg, agentId),
      });
      return {
        inferenceBinding: undefined,
        assertInferenceSelectionCurrent: () => authority.assertCurrent(),
        disposeInferenceAuthorization: () => authority.dispose(),
      };
    }
    // No explicit primary account in this edit: keep the recorded primary and refresh fallback
    // accounts whenever the chain may have changed, including a plain --model change.
    const chainEdited =
      patch.payload !== undefined && ("fallbacks" in patch.payload || "model" in patch.payload);
    if (chainEdited && nextJob.inferenceBinding) {
      return await refreshRecordedFallbackAccounts(
        nextJob,
        nextJob.inferenceBinding,
        cfg,
        agentId,
        caller,
        "fallbacks" in patch.payload!,
      );
    }
    return undefined;
  }
  // An account edit keeps the runtime the job records; otherwise it resolves the way create does.
  const recordedRuntime = nextJob.inferenceBinding?.runtime;
  const executionKey = resolveCronSessionTargetSessionKey(nextJob.sessionTarget);
  const executionEntry = executionKey
    ? (await loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: executionKey, agentId }))?.entry
    : undefined;
  const runtimeSessionEntry = await loadCronRuntimeSessionEntry({
    cfg,
    job: nextJob,
    agentId,
    executionEntry,
  });
  const inference = await captureCronInferenceForCaller(
    {
      cfg,
      agentId,
      model,
      executionSessionEntry: executionEntry,
      runtimeSessionEntry,
      recordedRuntime,
      fallbacks,
      recordedFallbackAccounts: nextJob.inferenceBinding?.fallbackAccounts,
      fallbacksSubmitted: patch.payload !== undefined && "fallbacks" in patch.payload,
    },
    caller,
  );
  if (inference.inferenceBinding === undefined) {
    if (cliExecution && !nextJob.inferenceBinding) {
      return undefined;
    }
    throw new Error("The selected automation account is unavailable.");
  }
  // An account edit on the same provider never moves the job off the runtime it records;
  // when that runtime is no longer available, the edit fails and the binding stays as it was.
  const capturedRuntime =
    inference.inferenceBinding === null ? cliExecution : inference.inferenceBinding.runtime;
  if (
    recordedRuntime &&
    capturedRuntime !== recordedRuntime &&
    (inference.inferenceBinding?.provider ?? selection.provider) ===
      nextJob.inferenceBinding?.provider
  ) {
    inference.disposeInferenceAuthorization();
    throw new Error(
      `The automation runs on runtime ${recordedRuntime}, which is unavailable for this account; the edit would move it to runtime ${capturedRuntime ?? "unknown"}.`,
    );
  }
  return inference;
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
