import type { AgentRuntimeRestrictionErrorDetails } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentHarnessSessionExecutionRestriction } from "../../agents/harness/execution-environment.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  getModelRefStatus,
  resolveAllowedModelRef,
  type ModelRef,
} from "../../agents/model-selection.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { applyModelRuntimeDirective } from "../../auto-reply/reply/directive-handling.model-runtime.js";
import { prepareModelSelectionRuntime } from "../../auto-reply/reply/model-runtime-normalization.js";
import { refreshQueuedFollowupSession } from "../../auto-reply/reply/queue.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionWorkerPlacementContext } from "../worker-environments/session-placement-lifecycle.js";
import { resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";

export function persistSessionPatchModelSelection(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  targetAgentId: string;
}): void {
  // Combined execution-policy recovery is explicitly scoped to this chat, even
  // when ordinary model selections normally update agent/global defaults.
  if (
    typeof params.patch.model !== "string" ||
    params.patch.sandboxMode !== undefined ||
    params.patch.nativeRuntimeConsent !== undefined ||
    params.entry.nativeRuntimeConsent !== undefined
  ) {
    return;
  }
  const policy = resolveGatewayModelSelectionPolicy({
    callerScopes: params.callerScopes,
    cfg: params.cfg,
  });
  if (policy.target === "session") {
    return;
  }
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  persistStickyModelSelectionBestEffort({
    agentId,
    model: `${resolved.provider}/${resolved.model}`,
    target: policy.target === "agent" ? "agent" : "defaults",
  });
}

/** Refresh only after commit, while this patch still holds session mutation ordering. */
export function refreshSessionPatchQueuedSelection(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  agentId: string;
  catalog?: ModelCatalogEntry[];
}): void {
  if (!("agentRuntime" in params.patch) && typeof params.patch.model !== "string") {
    return;
  }
  const { cfg, entry, sessionKey, agentId } = params;
  const model = resolveSessionModelRef(cfg, entry, agentId);
  refreshQueuedFollowupSession({
    key: sessionKey,
    nextProvider: model.provider,
    nextModel: model.model,
    nextRouteResolution: entry.modelOverrideRouteResolution,
    nextModelOverrideSource:
      entry.modelOverrideSource === "default" ? undefined : entry.modelOverrideSource,
    nextAuthProfileId: entry.authProfileOverride,
    nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(entry),
    nextThinking: {
      level: entry.thinkingLevel,
      catalog: params.catalog,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg,
        provider: model.provider,
        modelId: model.model,
        agentId,
        sessionKey,
        sessionEntry: entry,
      }),
    },
  });
}

export function resolveSessionPatchModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  subagentModelHint?: string;
  preparedModelSelection?: ModelRef;
}):
  | { ok: true; provider: string; model: string; profile?: string; isDefault: boolean }
  | { ok: false; error: string } {
  const { model: modelWithoutProfile, profile } = splitTrailingAuthProfile(params.raw);
  if (params.preparedModelSelection) {
    const ref = params.preparedModelSelection;
    if (modelWithoutProfile !== `${ref.provider}/${ref.model}`) {
      return { ok: false, error: "Resolved spawn model does not match the requested model." };
    }
    const status = getModelRefStatus({
      cfg: params.cfg,
      agentId: params.agentId,
      catalog: params.catalog,
      ref,
      defaultProvider: params.defaultProvider,
      defaultModel: params.subagentModelHint ?? {
        provider: params.defaultProvider,
        model: params.defaultModel,
      },
    });
    return status.allowed
      ? { ok: true, ...ref, ...(profile ? { profile } : {}), isDefault: false }
      : { ok: false, error: `model not allowed: ${status.key}` };
  }
  const resolved = resolveAllowedModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: params.catalog,
    raw: modelWithoutProfile,
    defaultProvider: params.defaultProvider,
    defaultModel: params.subagentModelHint ?? {
      provider: params.defaultProvider,
      model: params.defaultModel,
    },
  });
  if ("error" in resolved) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    ...(profile ? { profile } : {}),
    // A concrete model request is a pin even when it currently equals the
    // configured default. Only the explicit null patch represents Default.
    isDefault: false,
  };
}

/** Native selection and session operations expose the same per-chat recovery contract. */
export function resolveSessionNativeRuntimeRestriction(params: {
  operation: "fork" | "selection" | "send";
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry: Parameters<typeof resolveAgentHarnessSessionExecutionRestriction>[0]["entry"];
  persistedEntry: SessionEntry | undefined;
  harness: AgentHarness;
  provider: string;
  modelId: string;
  callerCanConsent: boolean;
}): ErrorShape | undefined {
  const { harness } = params;
  const restriction = resolveAgentHarnessSessionExecutionRestriction(params);
  if (!restriction) {
    return undefined;
  }
  const optional =
    restriction.reason !== "sandbox-required" && restriction.reason !== "remote-execution";
  // Creation has no persisted chat to authorize; its first send owns optional recovery.
  const persisted = params.persistedEntry;
  if (params.operation === "selection" && !persisted && optional) {
    return undefined;
  }
  const canRecover = params.callerCanConsent && optional && persisted;
  const details: AgentRuntimeRestrictionErrorDetails = {
    code: "AGENT_RUNTIME_RESTRICTED",
    runtimeId: harness.id,
    runtimeLabel: harness.label,
    reason: restriction.reason,
    ...(canRecover
      ? {
          recovery: {
            action: "use-native-permissions" as const,
            sessionId: persisted.sessionId,
            ...(persisted.lifecycleRevision
              ? { lifecycleRevision: persisted.lifecycleRevision }
              : {}),
            expectedPermissionMode: persisted.permissionMode ?? null,
            expectedSandboxMode: persisted.sandboxMode ?? null,
            expectedNativeRuntimeConsent: persisted.nativeRuntimeConsent ?? null,
          },
        }
      : {}),
  };
  return errorShape(ErrorCodes.INVALID_REQUEST, restriction.message, { details });
}

/** Bind runtime availability and placement checks to the selection's commit guard. */
export async function prepareSessionPatchRuntimeSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  patch: SessionsPatchParams;
  entry: SessionEntry;
  placement?: { context: SessionWorkerPlacementContext; sessionKey: string };
  catalog?: readonly ModelCatalogEntry[];
  callerCanConsent?: boolean;
  expectedEntry?: SessionEntry;
}): Promise<
  { ok: true; validate?: () => ErrorShape | undefined } | { ok: false; error: ErrorShape }
> {
  const invalid = (message: string) => ({
    ok: false as const,
    error: errorShape(ErrorCodes.INVALID_REQUEST, message),
  });
  let validateRuntime: (() => string | undefined) | undefined;
  let validateEnvironment: (() => ErrorShape | undefined) | undefined;
  const grantingConsent = typeof params.patch.nativeRuntimeConsent === "string";
  if (
    typeof params.patch.agentRuntime === "string" ||
    typeof params.patch.model === "string" ||
    grantingConsent
  ) {
    const model = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
    const previousModel = params.expectedEntry
      ? resolveSessionModelRef(params.cfg, params.expectedEntry, params.agentId)
      : undefined;
    const requestedProfile =
      typeof params.patch.model === "string"
        ? splitTrailingAuthProfile(params.patch.model).profile
        : undefined;
    const preservesRuntimeSelection =
      params.patch.agentRuntime === undefined &&
      !grantingConsent &&
      requestedProfile !== undefined &&
      previousModel?.provider === model.provider &&
      previousModel.model === model.model &&
      params.expectedEntry?.authProfileOverride === params.entry.authProfileOverride;
    if (!preservesRuntimeSelection) {
      const choice = await prepareModelSelectionRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.entry.spawnedWorkspaceDir,
        ...model,
        catalog: params.catalog ?? [],
        rawRuntime:
          typeof params.patch.agentRuntime === "string" ? params.patch.agentRuntime : undefined,
        sessionEntry: {
          ...params.entry,
          authProfileOverrideSource: resolveCollapsedSessionAuthPinSource(params.entry),
        },
      });
      if (choice.status === "rejected") {
        return invalid(choice.message);
      }
      applyModelRuntimeDirective(params.entry, choice.runtime);
      validateRuntime = choice.validateRuntimeSelection;
      const harness = choice.harness;
      if (grantingConsent) {
        if (
          !harness ||
          harness.executionEnvironment !== "host-only" ||
          harness.id !== params.patch.nativeRuntimeConsent
        ) {
          return invalid("Native runtime consent does not match the selected external runtime.");
        }
        params.entry.nativeRuntimeConsent = harness.id;
      }
      if (harness) {
        validateEnvironment = () =>
          resolveSessionNativeRuntimeRestriction({
            operation: "selection",
            cfg: params.cfg,
            agentId: params.agentId,
            sessionKey: params.placement?.sessionKey ?? params.patch.key,
            entry: params.entry,
            persistedEntry: params.expectedEntry,
            harness,
            provider: model.provider,
            modelId: model.model,
            callerCanConsent: params.callerCanConsent === true,
          });
      }
    }
  }
  const validate = () => {
    const environmentError = validateEnvironment?.();
    if (environmentError) {
      return environmentError;
    }
    const message =
      validateRuntime?.() ??
      (params.placement
        ? resolveSessionWorkerPlacementPatchError({
            cfg: params.cfg,
            agentId: params.agentId,
            context: params.placement.context,
            entry: params.entry,
            key: params.patch.key,
            sessionKey: params.placement.sessionKey,
            patch: params.patch,
            validateModelRuntime: true,
          })
        : undefined);
    return message ? errorShape(ErrorCodes.INVALID_REQUEST, message) : undefined;
  };
  const error = validate();
  return error
    ? { ok: false, error }
    : {
        ok: true,
        ...(params.patch.agentRuntime !== undefined ||
        params.patch.model !== undefined ||
        grantingConsent
          ? { validate }
          : {}),
      };
}
