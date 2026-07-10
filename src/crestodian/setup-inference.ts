// First-run inference activation: detect candidates, live-test, persist only on success.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeAuthProfileCredential } from "../agents/auth-profiles/credential-normalize.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  loadAuthProfileStoreForRuntime,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { describeFailoverError } from "../agents/failover-error.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
  detectInferenceBackends,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyMergePatch } from "../config/merge-patch.js";
import {
  normalizeAgentModelRefForConfig,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  runProviderPluginAuthMethodUnpersisted,
} from "../plugins/provider-auth-choice.js";
import {
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  type ProviderAuthChoiceMetadata,
} from "../plugins/provider-auth-choices.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import {
  projectDefaultInferenceRoute,
  resolveCrestodianConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { loadAuthoredSetupConfig } from "./onboarding-welcome.js";
import {
  applyCrestodianModelSelection,
  createCrestodianModelSelectionUpdater,
  createQuickstartNotePrompter,
} from "./setup-apply.js";

const log = createSubsystemLogger("crestodian/setup-inference");

/**
 * Inference is the one required onboarding step (docs/cli/crestodian.md
 * "Setup bootstrap"). This module gives structured clients (macOS app) the
 * same ladder the conversation uses, with one hard guarantee: a candidate is
 * persisted as the default model only after a real completion round-trips.
 * A failing candidate must never leave config pointing at a broken model.
 */
export const SETUP_INFERENCE_TEST_TIMEOUT_MS = 90_000;
const SETUP_INFERENCE_TEST_PROMPT = "Reply with the single word OK. Do not use tools.";
const SETUP_INFERENCE_TEST_MAX_TOKENS = 32;

export type SetupInferenceCandidate = {
  kind: InferenceBackendKind;
  label: string;
  detail: string;
  modelRef: string;
  recommended: boolean;
  credentials?: boolean;
};

export type SetupInferenceManualProvider = {
  /** Provider-auth choice id sent back to `crestodian.setup.activate`. */
  id: string;
  label: string;
  hint?: string;
};

export type SetupInferenceDetection = {
  candidates: SetupInferenceCandidate[];
  /** Text-inference key/token methods exposed by installed provider manifests. */
  manualProviders: SetupInferenceManualProvider[];
  /** Resolved workspace the setup apply would use (display + default). */
  workspace: string;
  configuredModel?: string;
  /** The connected Gateway already has a configured default-agent model. */
  setupComplete: boolean;
};

export type SetupInferenceStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unavailable"
  | "unknown";

export type SetupInferenceFailureStatus = Exclude<SetupInferenceStatus, "ok">;

export type ActivateSetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number; lines: string[] }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type VerifySetupInferenceResult =
  | { ok: true; modelRef: string; latencyMs: number }
  | { ok: false; status: SetupInferenceFailureStatus; error: string };

export type ActivateSetupInferenceParams = {
  kind: InferenceBackendKind | "api-key";
  /** Manual step only: provider-auth choice returned by detection. */
  authChoice?: string;
  /** Manual step only: the pasted API key or token. Never logged. */
  apiKey?: string;
  workspace?: string;
  surface: "cli" | "gateway";
  runtime: RuntimeEnv;
  deps?: ActivateSetupInferenceDeps;
};

export type ActivateSetupInferenceDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  ensureCodexRuntimePlugin?: typeof import("../commands/codex-runtime-plugin-install.js").ensureCodexRuntimePluginForModelSelection;
  transformConfigWithPendingPluginInstalls?: typeof import("../plugins/install-record-commit.js").transformConfigWithPendingPluginInstalls;
  refreshPluginRegistryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").refreshPluginRegistryAfterConfigMutation;
  resolvePluginProviders?: typeof resolvePluginProviders;
  resolveManifestProviderAuthChoice?: typeof resolveManifestProviderAuthChoice;
  enablePluginInConfig?: typeof enablePluginInConfig;
  updateAuthProfileStoreWithLock?: typeof updateAuthProfileStoreWithLock;
  loadPersistedAuthProfileStore?: typeof loadPersistedAuthProfileStore;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
  readPersistedInstalledPluginIndexInstallRecords?: typeof import("../plugins/installed-plugin-index-records.js").readPersistedInstalledPluginIndexInstallRecords;
  markRetainedManagedNpmInstall?: typeof import("../plugins/managed-npm-retention.js").markRetainedManagedNpmInstall;
  clearLoadInstalledPluginIndexInstallRecordsCache?: typeof import("../plugins/installed-plugin-index-records.js").clearLoadInstalledPluginIndexInstallRecordsCache;
  clearPluginMetadataLifecycleCaches?: typeof import("../plugins/plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
  invalidatePluginRuntimeDiscoveryAfterConfigMutation?: typeof import("../plugins/registry-refresh.js").invalidatePluginRuntimeDiscoveryAfterConfigMutation;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (dir: string) => Promise<void>;
  timeoutMs?: number;
};

export type DetectSetupInferenceDeps = {
  resolveManifestProviderAuthChoices?: typeof resolveManifestProviderAuthChoices;
};

async function resolveSetupInferenceWorkspace(params: {
  configExists: boolean;
  configValid: boolean;
}): Promise<{ workspace: string; hasAuthoredSetup: boolean }> {
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig(params);
  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  return {
    workspace: resolveUserPath(
      authoredConfig?.agents?.defaults?.workspace?.trim() || DEFAULT_WORKSPACE,
    ),
    hasAuthoredSetup,
  };
}

function supportsTextInference(scopes?: ProviderAuthChoiceMetadata["onboardingScopes"]): boolean {
  return !scopes || scopes.includes("text-inference");
}

function supportsManualSecret(choice: ProviderAuthChoiceMetadata): boolean {
  return supportsTextInference(choice.onboardingScopes) && choice.appGuidedSecret === true;
}

export function listSetupInferenceManualProviders(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceManualProvider[] {
  const choices = new Map<string, SetupInferenceManualProvider>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (!id || choices.has(id) || !supportsManualSecret(choice)) {
      continue;
    }
    choices.set(id, {
      id,
      label: choice.choiceLabel,
      ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    });
  }
  return [...choices.values()].toSorted(
    (a, b) => a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id, "en"),
  );
}

export async function detectSetupInference(
  deps: DetectSetupInferenceDeps = {},
): Promise<SetupInferenceDetection> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const detected = await detectInferenceBackends({ config: cfg });
  // Gemini CLI has no hard tool-off mode: wildcard exclusions can be
  // overridden by admin policy and do not stop discovery or MCP startup.
  // Keep normal agent support, but never offer it for the setup safety probe.
  const raw = detected.filter((candidate) => candidate.kind !== "gemini-cli");
  // Recommended = the first candidate setup itself would bootstrap with; a
  // definitively logged-out CLI never gets the badge.
  const recommendedIndex = raw.findIndex((candidate) => candidate.credentials !== false);
  const candidates = raw.map((candidate, index) => ({
    ...candidate,
    recommended: index === recommendedIndex,
  }));
  const { workspace } = await resolveSetupInferenceWorkspace({
    configExists: snapshot.exists,
    configValid: snapshot.valid,
  });
  const configuredModel = raw.find((candidate) => candidate.kind === "existing-model")?.modelRef;
  const authChoices = (
    deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: cfg,
    workspaceDir: workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  }).filter((choice) => enablePluginInConfig(cfg, choice.pluginId).enabled);
  return {
    candidates,
    manualProviders: listSetupInferenceManualProviders(authChoices),
    workspace,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: Boolean(configuredModel),
  };
}

type SetupInferenceTestPlan = {
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  modelRef: string;
  config: OpenClawConfig;
  /** Execution identity used by the real Crestodian turn. */
  agentId?: string;
  /** Default-agent owner whose model/runtime config is being selected. */
  routeAgentId?: string;
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  cleanupBundleMcpOnRunEnd?: boolean;
  authProfileId?: string;
  /** Model to persist as default on success; undefined keeps the current one. */
  persistModelRef?: string;
  manualAuth?: {
    profiles: ProviderAuthResult["profiles"];
    configBase: OpenClawConfig;
    configPatch: unknown;
    pluginId?: string;
  };
};

type RunResult = {
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta?: {
    executionTrace?: { winnerProvider?: string; winnerModel?: string };
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    livenessState?: string;
    error?: { kind?: string; message?: string };
  };
};

function extractRunText(result: RunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

function extractRunTerminalError(result: RunResult): string | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError === true)?.text?.trim();
  const hasMetaError = result.meta?.error !== undefined;
  const metaError = result.meta?.error?.message?.trim();
  const livenessState = result.meta?.livenessState?.trim().toLowerCase();
  if (
    !errorPayload &&
    !hasMetaError &&
    livenessState !== "blocked" &&
    livenessState !== "abandoned"
  ) {
    return undefined;
  }
  return (
    metaError ||
    errorPayload ||
    (livenessState ? `Inference ended in the ${livenessState} state.` : "Inference failed.")
  );
}

function extractRunWinnerError(
  plan: SetupInferenceTestPlan,
  result: RunResult,
): string | undefined {
  const winnerProvider = result.meta?.executionTrace?.winnerProvider?.trim();
  const winnerModel = result.meta?.executionTrace?.winnerModel?.trim();
  if (!winnerProvider || !winnerModel) {
    return "The inference run did not report which provider and model produced its reply.";
  }
  if (winnerProvider === plan.provider && winnerModel === plan.model) {
    return undefined;
  }
  return `The inference run answered through ${winnerProvider}/${winnerModel} instead of the requested ${plan.provider}/${plan.model}. Disable model-routing overrides or choose the working route directly, then retry.`;
}

function resolveToolFreeCliSetupError(plan: SetupInferenceTestPlan): string | undefined {
  if (plan.runner !== "cli") {
    return undefined;
  }
  const backend = resolveCliBackendConfig(
    plan.provider,
    plan.config,
    plan.agentId ? { agentId: plan.agentId } : {},
  );
  if (backend?.sideQuestionToolMode === "disabled") {
    return undefined;
  }
  const geminiCliProvider = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF).provider;
  if (backend?.nativeToolMode !== "always-on" && plan.provider !== geminiCliProvider) {
    return undefined;
  }
  return plan.provider === geminiCliProvider
    ? "Gemini CLI cannot be used for inference-gated setup because it has no hard tool-free mode. Choose Claude Code, Codex, or an API-key provider; normal Gemini CLI agent runs remain available after setup."
    : `CLI backend ${backend?.id ?? plan.provider} cannot be used for inference-gated setup because it has no hard tool-free mode. Choose another inference provider.`;
}

function resolveStrictSetupAuthProfileError(params: {
  plan: SetupInferenceTestPlan;
  workspaceDir: string;
  deps: ActivateSetupInferenceDeps;
}): string | undefined {
  const profileId = params.plan.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const loadStore = params.deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const store = loadStore(params.plan.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: params.plan.config,
  });
  const credential = store.profiles[profileId];
  if (!credential) {
    return `No credentials found for the configured setup profile "${profileId}".`;
  }

  if (params.plan.runner === "embedded") {
    const authPlan = buildAgentRuntimeAuthPlan({
      provider: params.plan.provider,
      authProfileProvider: credential.provider,
      authProfileMode: credential.type,
      sessionAuthProfileId: profileId,
      config: params.plan.config,
      workspaceDir: params.workspaceDir,
      harnessId: params.plan.agentHarnessRuntimeOverride,
      harnessRuntime: params.plan.agentHarnessRuntimeOverride,
      allowHarnessAuthProfileForwarding: true,
    });
    if (authPlan.forwardedAuthProfileId === profileId) {
      return undefined;
    }
  } else {
    const aliasContext = {
      config: params.plan.config,
      workspaceDir: params.workspaceDir,
    };
    try {
      const runProvider = resolveProviderIdForAuth(params.plan.provider, aliasContext);
      const profileProvider = resolveProviderIdForAuth(credential.provider, aliasContext);
      if (runProvider === profileProvider) {
        return undefined;
      }
    } catch {
      return `Could not verify that configured setup profile "${profileId}" belongs to the selected ${params.plan.provider} inference route.`;
    }
  }

  return `Configured setup profile "${profileId}" belongs to ${credential.provider}, not the selected ${params.plan.provider} inference route.`;
}

function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function resolveSetupAgentRuntimeId(
  kind: ActivateSetupInferenceParams["kind"],
): string | undefined {
  if (kind === "codex-cli") {
    return "codex";
  }
  if (kind === "openai-api-key" || kind === "anthropic-api-key" || kind === "api-key") {
    return "openclaw";
  }
  return undefined;
}

function mapFailoverReasonToSetupStatus(reason?: string | null): SetupInferenceFailureStatus {
  if (reason === "auth" || reason === "auth_permanent") {
    return "auth";
  }
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "format" || reason === "model_not_found") {
    return "format";
  }
  return "unknown";
}

function prepareManualAuthForActivation(params: {
  baseConfig: OpenClawConfig;
  preparedConfig: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  selectedProfileId: string;
}): {
  config: OpenClawConfig;
  profiles: ProviderAuthResult["profiles"];
  selectedProfileId: string;
} {
  const profileIdMap = new Map<string, string>();
  const profiles = params.profiles.map((profile) => {
    const provider = normalizeProviderId(profile.credential.provider) || "provider";
    const profileId = `${provider}:setup-${randomUUID()}`;
    profileIdMap.set(profile.profileId, profileId);
    return { ...profile, profileId };
  });
  const selectedProfileId = profileIdMap.get(params.selectedProfileId);
  if (!selectedProfileId) {
    throw new Error("The selected setup credential was not returned by its provider.");
  }

  const preparedProfiles = { ...params.preparedConfig.auth?.profiles };
  for (const profile of params.profiles) {
    const nextProfileId = profileIdMap.get(profile.profileId);
    if (!nextProfileId) {
      continue;
    }
    const metadata = preparedProfiles[profile.profileId] ?? {
      provider: profile.credential.provider,
      mode: profile.credential.type,
    };
    const previousMetadata = params.baseConfig.auth?.profiles?.[profile.profileId];
    if (previousMetadata) {
      preparedProfiles[profile.profileId] = previousMetadata;
    } else {
      delete preparedProfiles[profile.profileId];
    }
    preparedProfiles[nextProfileId] = metadata;
  }
  const auth = {
    ...params.preparedConfig.auth,
    profiles: preparedProfiles,
  };
  // The selected model is pinned to the verified profile. Provider setup must
  // not rewrite an operator's independent fallback order as a side effect.
  if (params.baseConfig.auth?.order) {
    auth.order = structuredClone(params.baseConfig.auth.order);
  } else {
    delete auth.order;
  }
  return {
    config: { ...params.preparedConfig, auth },
    profiles,
    selectedProfileId,
  };
}

async function buildTestPlan(params: {
  kind: InferenceBackendKind | "api-key";
  authChoice?: string;
  apiKey?: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
  pluginWorkspaceDir: string;
  agentDir: string;
  runtime: RuntimeEnv;
  deps: ActivateSetupInferenceDeps;
}): Promise<SetupInferenceTestPlan | { error: string }> {
  const { kind, cfg, workspaceDir } = params;
  switch (kind) {
    case "existing-model": {
      const route = await resolveCrestodianConfiguredRouteFromConfig(cfg);
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      return {
        runner: route.runner,
        provider: route.provider,
        model: route.model,
        modelRef: route.modelLabel,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: route.agentId,
        agentDir: route.agentDir,
        ...(route.runner === "embedded"
          ? { agentHarnessRuntimeOverride: route.agentHarnessRuntimeOverride }
          : {}),
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "claude-cli": {
      const ref = parseRef(CLAUDE_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "gemini-cli": {
      const ref = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF);
      return {
        runner: "cli",
        ...ref,
        modelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
      };
    }
    case "codex-cli": {
      const ref = parseRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        agentDir: params.agentDir,
        cleanupBundleMcpOnRunEnd: true,
        persistModelRef: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
      };
    }
    case "openai-api-key": {
      const ref = parseRef(OPENAI_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: OPENAI_API_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: OPENAI_API_DEFAULT_MODEL_REF,
      };
    }
    case "anthropic-api-key": {
      const ref = parseRef(ANTHROPIC_API_DEFAULT_MODEL_REF);
      return {
        runner: "embedded",
        ...ref,
        modelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
        config: cfg,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(cfg),
        persistModelRef: ANTHROPIC_API_DEFAULT_MODEL_REF,
      };
    }
    case "api-key": {
      const apiKey = params.apiKey?.trim();
      if (!apiKey) {
        return { error: "Enter an API key or token first." };
      }
      const authChoice = params.authChoice?.trim();
      const choice = authChoice
        ? (params.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
            authChoice,
            {
              config: cfg,
              workspaceDir: params.pluginWorkspaceDir,
              includeUntrustedWorkspacePlugins: false,
              includeWorkspacePlugins: false,
            },
          )
        : undefined;
      if (!choice || !supportsManualSecret(choice)) {
        return { error: "That key-based provider is not available on this Gateway." };
      }
      const enableResult = (params.deps.enablePluginInConfig ?? enablePluginInConfig)(
        cfg,
        choice.pluginId,
      );
      if (!enableResult.enabled) {
        return {
          error: `${choice.choiceLabel} is disabled (${enableResult.reason ?? "blocked"}).`,
        };
      }
      const providers = (params.deps.resolvePluginProviders ?? resolvePluginProviders)({
        config: enableResult.config,
        workspaceDir: params.pluginWorkspaceDir,
        mode: "setup",
        includeUntrustedWorkspacePlugins: false,
        onlyPluginIds: [choice.pluginId],
      });
      const provider = providers.find(
        (candidate) =>
          candidate.pluginId === choice.pluginId &&
          normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
      );
      const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
      const resolved = provider && method ? { provider, method } : null;
      if (!resolved || !supportsTextInference(resolved.method.wizard?.onboardingScopes)) {
        return { error: "That key-based provider is not available on this Gateway." };
      }
      let result: ProviderAuthResult;
      let preparedConfig: OpenClawConfig;
      try {
        if (resolved.method.kind === "api_key" || resolved.method.kind === "token") {
          result = await runProviderPluginAuthMethodUnpersisted({
            config: enableResult.config,
            runtime: params.runtime,
            prompter: createQuickstartNotePrompter(params.runtime),
            method: resolved.method,
            agentDir: params.agentDir,
            workspaceDir,
            secretInputMode: "plaintext",
            allowSecretRefPrompt: false,
            opts: { token: apiKey, tokenProvider: resolved.provider.id },
          });
          preparedConfig = applyProviderPluginAuthMethodResultConfig({
            config: enableResult.config,
            result,
          });
        } else {
          const prepared = await runProviderManualSecretMethod({
            config: enableResult.config,
            baseConfig: cfg,
            choice,
            method: resolved.method,
            apiKey,
            agentDir: params.agentDir,
            workspaceDir,
          });
          result = prepared.result;
          preparedConfig = prepared.config;
        }
      } catch {
        return {
          error: `${resolved.provider.label} could not prepare this credential for app-guided setup.`,
        };
      }
      const modelRef = result.defaultModel
        ? normalizeAgentModelRefForConfig(result.defaultModel)
        : "";
      if (!modelRef || result.profiles.length === 0) {
        return {
          error: `${resolved.provider.label} does not expose a starter model for app-guided setup.`,
        };
      }
      const ref = parseRef(modelRef);
      if (!ref.model) {
        return {
          error: `${resolved.provider.label} returned an invalid starter model.`,
        };
      }
      const matchingProfile =
        result.profiles.find(
          (profile) =>
            normalizeProviderId(profile.credential.provider) === normalizeProviderId(ref.provider),
        ) ?? result.profiles[0];
      const preparedAuth = prepareManualAuthForActivation({
        baseConfig: enableResult.config,
        preparedConfig,
        profiles: result.profiles,
        selectedProfileId: matchingProfile.profileId,
      });
      return {
        runner: "embedded",
        ...ref,
        modelRef,
        agentDir: params.agentDir,
        config: preparedAuth.config,
        agentId: "crestodian",
        routeAgentId: resolveDefaultAgentId(preparedAuth.config),
        authProfileId: preparedAuth.selectedProfileId,
        persistModelRef: modelRef,
        manualAuth: {
          profiles: preparedAuth.profiles,
          configBase: enableResult.config,
          configPatch: createMergePatch(enableResult.config, preparedAuth.config),
          ...(resolved.provider.pluginId ? { pluginId: resolved.provider.pluginId } : {}),
        },
      };
    }
    default:
      return { error: `Unknown inference choice "${String(kind)}".` };
  }
}

async function runProviderManualSecretMethod(params: {
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  choice: ProviderAuthChoiceMetadata;
  method: ProviderAuthMethod;
  apiKey: string;
  agentDir: string;
  workspaceDir: string;
}): Promise<{ result: ProviderAuthResult; config: OpenClawConfig }> {
  const optionKey = params.choice.optionKey;
  const runNonInteractive = params.method.runNonInteractive;
  if (!optionKey || !params.choice.cliOption || !runNonInteractive) {
    throw new Error("Provider does not expose app-guided secret setup.");
  }

  let methodError = "";
  const isolatedRuntime: RuntimeEnv = {
    log: () => {},
    error: (...args) => {
      methodError = args.map(String).join(" ");
    },
    // Provider CLI methods use exit for validation failures. Convert it to a
    // request-local failure so app-guided setup can never stop the Gateway.
    exit: (code) => {
      throw new Error(methodError || `Provider setup exited with code ${code}.`);
    },
  };
  const configured = await runNonInteractive({
    authChoice: params.choice.choiceId,
    config: params.config,
    baseConfig: params.baseConfig,
    opts: { [optionKey]: params.apiKey, secretInputMode: "plaintext" },
    runtime: isolatedRuntime,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    resolveApiKey: async (input) =>
      typeof input.flagValue === "string" && input.flagValue.trim()
        ? { key: input.flagValue.trim(), source: "flag" }
        : null,
    toApiKeyCredential: ({ provider, resolved, email, metadata }) => ({
      type: "api_key",
      provider,
      key: resolved.key,
      ...(email ? { email } : {}),
      ...(metadata ? { metadata } : {}),
    }),
  });
  if (!configured) {
    throw new Error(methodError || "Provider setup did not produce a configuration.");
  }

  const store = loadPersistedAuthProfileStore(params.agentDir);
  const profiles = Object.entries(store?.profiles ?? {}).map(([profileId, credential]) => ({
    profileId,
    credential,
  }));
  const previousModel = resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  const configuredModel = resolveAgentModelPrimaryValue(configured.agents?.defaults?.model);
  const configuredProvider = configuredModel ? parseRef(configuredModel).provider : undefined;
  // Dynamic provider setup can rediscover the already-selected model while
  // repairing credentials. It is valid only when the provider still owns it.
  const configuredModelOwnedByProvider =
    configuredProvider !== undefined &&
    normalizeProviderId(configuredProvider) === normalizeProviderId(params.choice.providerId);
  const defaultModel =
    configuredModel && (configuredModel !== previousModel || configuredModelOwnedByProvider)
      ? configuredModel
      : params.method.starterModel;
  if (profiles.length === 0 || !defaultModel) {
    throw new Error("Provider setup did not produce credentials and a starter model.");
  }
  return {
    result: { profiles, defaultModel },
    config: configured,
  };
}

/**
 * Test one candidate with a real completion, then persist it as the setup
 * default. Manual credentials are tested from a temporary auth store and
 * copied into the real agent store only after success, so failures leave no trace.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    const result = await activateSetupInferenceUnredacted(params);
    if (result.ok) {
      return result;
    }
    return {
      ...result,
      error: await redactSetupInferenceError(result.error, params.apiKey),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(await redactSetupInferenceError(message, params.apiKey));
  }
}

async function activateSetupInferenceUnredacted(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  const cfg: OpenClawConfig =
    snapshot.exists && snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const workspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace)
    : (
        await resolveSetupInferenceWorkspace({
          configExists: snapshot.exists,
          configValid: snapshot.valid,
        })
      ).workspace;

  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  const testAgentDir = path.join(tempDir, "agent");
  let pendingCodexInstall: PluginInstallRecord | undefined;
  let codexInstallOwnership: "unknown" | "owned" | "unowned" = "unknown";
  try {
    const plan = await buildTestPlan({
      kind: params.kind,
      ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
      ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
      cfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: workspace,
      agentDir: testAgentDir,
      runtime: params.runtime,
      deps,
    });
    if ("error" in plan) {
      return { ok: false, status: "unavailable", error: plan.error };
    }

    let testPlan = plan;
    if (plan.persistModelRef) {
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      const stagedConfig = await applyCrestodianModelSelection({
        config: plan.config,
        model: plan.persistModelRef,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        routeAgentId: resolveDefaultAgentId(stagedConfig),
      };
    }

    let codexPluginPatch: unknown;
    if (params.kind === "codex-cli") {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      // This explicit Codex CLI choice owns its runtime independently of the
      // user's existing OpenAI provider route (which may use a custom base URL).
      const codexInstallBase = stripPendingPluginInstallRecords(testPlan.config);
      const enabledCodexBase = enablePluginInConfig(codexInstallBase, "codex");
      if (!enabledCodexBase.enabled) {
        return {
          ok: false,
          status: "unavailable",
          error: `Could not enable the Codex runtime plugin: ${enabledCodexBase.reason ?? "plugin disabled"}.`,
        };
      }
      const ensureCodex =
        deps.ensureCodexRuntimePlugin ??
        (await import("../commands/codex-runtime-plugin-install.js"))
          .ensureCodexRuntimePluginForModelSelection;
      const ensured = await ensureCodex({
        cfg: enabledCodexBase.config,
        model: plan.modelRef,
        agentId: testPlan.routeAgentId,
        prompter: createQuickstartNotePrompter(params.runtime),
        runtime: params.runtime,
        workspaceDir: tempDir,
      });
      if (!ensured.installed) {
        return {
          ok: false,
          status: ensured.status === "timed_out" ? "timeout" : "unavailable",
          error:
            ensured.status === "timed_out"
              ? "Codex runtime plugin installation timed out. Try again."
              : ensured.reason
                ? `Could not enable the Codex runtime plugin: ${ensured.reason}.`
                : "Could not install the Codex runtime plugin. Try again once the plugin is available.",
        };
      }
      pendingCodexInstall = ensured.cfg.plugins?.installs?.codex;
      const enabledCodex = enablePluginInConfig(ensured.cfg, "codex");
      if (!enabledCodex.enabled) {
        return {
          ok: false,
          status: "unavailable",
          error: `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
        };
      }
      // Discovery needs the just-installed package record during the probe, but
      // install ownership remains transient until inference succeeds.
      const stagedCodexConfig = enabledCodex.config;
      codexPluginPatch = createMergePatch(
        codexInstallBase,
        stripPendingPluginInstallRecords(stagedCodexConfig),
      );
      testPlan = {
        ...testPlan,
        config: stagedCodexConfig,
      };
    }
    const baselineRoute = await projectDefaultInferenceRoute(cfg);
    const verifiedRoute = await projectDefaultInferenceRoute(testPlan.config);
    const stagedRoute = verifiedRoute.route;
    if (
      !stagedRoute ||
      stagedRoute.runner !== testPlan.runner ||
      stagedRoute.provider !== testPlan.provider ||
      stagedRoute.model !== testPlan.model ||
      stagedRoute.modelLabel !== plan.modelRef ||
      (plan.manualAuth && stagedRoute.authProfileId !== plan.authProfileId)
    ) {
      return {
        ok: false,
        status: "unavailable",
        error:
          "The staged default-agent route does not match the requested inference candidate. Review model runtime policy and retry.",
      };
    }
    if (testPlan.runner === "embedded" && stagedRoute.runner === "embedded") {
      testPlan = {
        ...testPlan,
        agentHarnessRuntimeOverride: stagedRoute.agentHarnessRuntimeOverride,
      };
    }

    if (plan.manualAuth) {
      const staged = await persistManualAuthProfiles({
        profiles: plan.manualAuth.profiles,
        agentDir: testAgentDir,
        deps,
      });
      if (!staged) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Could not stage the credential for its live inference test; try again in a moment.",
        };
      }
    }

    const test = await runSetupInferenceTest({
      plan: testPlan,
      tempDir,
      deps,
      authProfileStateMode: "read-write",
    });
    if (!test.ok) {
      return test;
    }

    const needsPersistence =
      plan.persistModelRef !== undefined ||
      plan.manualAuth !== undefined ||
      codexPluginPatch !== undefined ||
      pendingCodexInstall !== undefined;
    let committedConfig: OpenClawConfig | undefined;
    if (!needsPersistence) {
      const latestSnapshot = await readSnapshot();
      const latestRuntime =
        latestSnapshot.exists && latestSnapshot.valid
          ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
          : undefined;
      const latestRoute = latestRuntime
        ? await projectDefaultInferenceRoute(latestRuntime)
        : undefined;
      if (!latestRoute || !sameDefaultInferenceRoute(latestRoute, verifiedRoute)) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route changed during its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
    }
    if (needsPersistence) {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      const selectModel = plan.persistModelRef
        ? await createCrestodianModelSelectionUpdater({
            model: plan.persistModelRef,
            ...(agentRuntimeId ? { agentRuntimeId } : {}),
            ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
          })
        : undefined;
      const stageCandidate = (current: OpenClawConfig): OpenClawConfig => {
        let next =
          codexPluginPatch === undefined ? current : stripPendingPluginInstallRecords(current);
        if (plan.manualAuth) {
          next = applyManualAuthConfig(
            next,
            plan.manualAuth,
            deps.enablePluginInConfig ?? enablePluginInConfig,
          );
        }
        if (codexPluginPatch !== undefined) {
          next = applyMergePatch(next, codexPluginPatch) as OpenClawConfig;
        }
        next = selectModel ? selectModel(next) : next;
        if (!pendingCodexInstall) {
          return next;
        }
        return {
          ...next,
          plugins: {
            ...next.plugins,
            installs: { codex: pendingCodexInstall },
          },
        };
      };
      // Resolve every fallible config-commit dependency before writing a
      // credential into the real agent store. From this point onward, any
      // failure is inside the rollback boundary below.
      const transformConfig =
        deps.transformConfigWithPendingPluginInstalls ??
        (await import("../plugins/install-record-commit.js"))
          .transformConfigWithPendingPluginInstalls;
      let manualAuthReceipt: ManualAuthPersistenceReceipt | undefined;
      if (plan.manualAuth) {
        const initialCandidate = stageCandidate(cfg);
        const initialRoute = await projectDefaultInferenceRoute(initialCandidate);
        const resolvedRoute = await resolveCrestodianConfiguredRouteFromConfig(initialCandidate);
        if (
          !sameDefaultInferenceRoute(initialRoute, verifiedRoute) ||
          !resolvedRoute ||
          resolvedRoute.modelLabel !== plan.modelRef ||
          resolvedRoute.authProfileId !== plan.authProfileId
        ) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified credential was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        const persistedManualAuth = await persistManualAuthProfiles({
          profiles: plan.manualAuth.profiles,
          agentDir: resolvedRoute.agentDir,
          deps,
        });
        if (!persistedManualAuth) {
          return {
            ok: false,
            status: "unknown",
            error: "Could not save the verified credential; try again in a moment.",
          };
        }
        manualAuthReceipt = persistedManualAuth;
      }
      try {
        const committed = await transformConfig({
          base: "source",
          // The transform stays side-effect free so a config conflict can retry
          // without replaying credential writes in another agent directory.
          afterWrite: { mode: "none", reason: "Crestodian activates verified inference" },
          transform: async (current, context) => {
            const latestRuntime = context.snapshot.runtimeConfig ?? context.snapshot.config;
            const latestBaseline = await projectDefaultInferenceRoute(latestRuntime);
            if (!sameDefaultInferenceRoute(latestBaseline, baselineRoute)) {
              throw new Error(
                "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            const stagedRuntime = stageCandidate(latestRuntime);
            const currentRoute = await projectDefaultInferenceRoute(stagedRuntime);
            if (!sameDefaultInferenceRoute(currentRoute, verifiedRoute)) {
              throw new Error(
                "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
              );
            }
            const resolvedRoute = await resolveCrestodianConfiguredRouteFromConfig(stagedRuntime);
            if (
              !resolvedRoute ||
              resolvedRoute.modelLabel !== plan.modelRef ||
              (plan.manualAuth && resolvedRoute.authProfileId !== plan.authProfileId)
            ) {
              throw new Error(
                "The latest default-agent route no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
              );
            }
            return { nextConfig: stageCandidate(current) };
          },
        });
        committedConfig = committed.nextConfig;
        if (pendingCodexInstall) {
          codexInstallOwnership = "owned";
        }
      } catch (error) {
        const reconciledSnapshot = await readSnapshot().catch(() => null);
        const reconciledRuntime =
          reconciledSnapshot?.exists && reconciledSnapshot.valid
            ? (reconciledSnapshot.runtimeConfig ?? reconciledSnapshot.config)
            : undefined;
        const reconciledRoute = reconciledRuntime
          ? await projectDefaultInferenceRoute(reconciledRuntime)
          : undefined;
        const codexInstallPersisted = pendingCodexInstall
          ? await isCodexInstallRecordPersisted(pendingCodexInstall, deps)
          : true;
        if (pendingCodexInstall) {
          codexInstallOwnership = codexInstallPersisted ? "owned" : "unowned";
        }
        const committedDespiteError =
          reconciledRoute !== undefined &&
          sameDefaultInferenceRoute(reconciledRoute, verifiedRoute) &&
          (!manualAuthReceipt || manualAuthProfilesPersisted(manualAuthReceipt, deps)) &&
          codexInstallPersisted;
        if (!committedDespiteError) {
          if (manualAuthReceipt) {
            if (
              !reconciledRuntime ||
              configReferencesManualAuthProfiles(reconciledRuntime, manualAuthReceipt)
            ) {
              throw new Error(
                "Inference activation could not confirm its config commit state. The verified credential was retained because the current config may reference it. Run openclaw doctor --fix before retrying.",
                { cause: error },
              );
            }
            const rolledBack = await rollbackManualAuthProfiles(manualAuthReceipt, deps);
            if (!rolledBack) {
              throw new Error(
                "Inference activation failed and its staged credential could not be rolled back. Run openclaw doctor --fix before retrying.",
                { cause: error },
              );
            }
          }
          throw error;
        }
        committedConfig = reconciledSnapshot?.sourceConfig ?? reconciledRuntime;
        log.warn("Inference activation committed successfully despite a post-write cleanup error.");
      }
    }
    if (codexPluginPatch !== undefined && committedConfig) {
      const refreshPluginRegistry =
        deps.refreshPluginRegistryAfterConfigMutation ??
        (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
      try {
        await refreshPluginRegistry({
          config: committedConfig,
          reason: "source-changed",
          workspaceDir: workspace,
          logger: log,
        });
      } catch {
        log.warn("Codex runtime registry refresh will retry on the next Gateway load.");
      }
    }
    return {
      ok: true,
      modelRef: plan.modelRef,
      latencyMs: test.latencyMs,
      lines: [`Inference verified: ${plan.modelRef}`],
    };
  } finally {
    if (pendingCodexInstall && codexInstallOwnership !== "owned") {
      await retainUnownedCodexInstall({
        record: pendingCodexInstall,
        verifyOwnership: codexInstallOwnership === "unknown",
        deps,
      });
    }
    await cleanupSetupInferenceTempDir({ tempDir, deps });
  }
}

async function redactSetupInferenceError(message: string, apiKey?: string): Promise<string> {
  const secrets = new Set(
    [apiKey, apiKey?.trim()].filter((value): value is string => Boolean(value)),
  );
  let redacted = message;
  for (const secret of Array.from(secrets).toSorted((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  const { redactToolPayloadText } = await import("../logging/redact.js");
  return redactToolPayloadText(redacted);
}

/** Live-test the configured default model without changing config or auth state. */
export async function verifySetupInference(params: {
  kind?: "existing-model";
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
}): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return {
      ok: false,
      status: "unavailable",
      error: "No OpenClaw config exists. Run `openclaw onboard` first.",
    };
  }
  if (!snapshot.valid) {
    return {
      ok: false,
      status: "unavailable",
      error: "OpenClaw config is invalid. Run `openclaw doctor --fix` before continuing.",
    };
  }
  const cfg: OpenClawConfig = snapshot.runtimeConfig ?? snapshot.config;
  const baselineRoute = await projectDefaultInferenceRoute(cfg);
  const verification = await verifySetupInferenceConfig({
    config: cfg,
    runtime: params.runtime,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
  });
  if (!verification.ok) {
    return verification;
  }
  const latestSnapshot = await readSnapshot().catch(() => null);
  const latestConfig =
    latestSnapshot?.exists && latestSnapshot.valid
      ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
      : undefined;
  const latestRoute = latestConfig ? await projectDefaultInferenceRoute(latestConfig) : undefined;
  if (!latestRoute || !sameDefaultInferenceRoute(baselineRoute, latestRoute)) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The default-agent inference route changed during its live test. Review the current model/auth/runtime settings and retry.",
    };
  }
  return verification;
}

/** Live-test a staged default-agent route before any caller persists it. */
export async function verifySetupInferenceConfig(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
}): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const cfg = params.config;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (!resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)) {
    return {
      ok: false,
      status: "unavailable",
      error: "No default-agent model is configured. Run `openclaw onboard` first.",
    };
  }
  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const plan = await buildTestPlan({
      kind: "existing-model",
      cfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: tempDir,
      agentDir: path.join(tempDir, "agent"),
      runtime: params.runtime,
      deps,
    });
    if ("error" in plan) {
      return { ok: false, status: "unavailable", error: plan.error };
    }
    const test = await runSetupInferenceTest({
      plan,
      tempDir,
      deps,
      authProfileStateMode: "read-only",
    });
    if (test.ok) {
      return { ...test, modelRef: plan.modelRef };
    }
    return {
      ...test,
      error: await redactSetupInferenceError(test.error),
    };
  } finally {
    await cleanupSetupInferenceTempDir({ tempDir, deps });
  }
}

async function cleanupSetupInferenceTempDir(params: {
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<void> {
  try {
    await (
      params.deps.removeTempDir ?? ((dir: string) => fs.rm(dir, { recursive: true, force: true }))
    )(params.tempDir);
  } catch {
    // Cleanup happens after the inference result or durable activation. It must
    // never turn a verified/committed route into a failed client RPC.
    log.warn("Could not remove the temporary inference test directory.");
  }
}

async function isCodexInstallRecordPersisted(
  record: PluginInstallRecord,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  try {
    const readInstallRecords =
      deps.readPersistedInstalledPluginIndexInstallRecords ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .readPersistedInstalledPluginIndexInstallRecords;
    const currentInstallRecords = await readInstallRecords();
    return currentInstallRecords !== null && isDeepStrictEqual(currentInstallRecords.codex, record);
  } catch {
    return false;
  }
}

async function retainUnownedCodexInstall(params: {
  record: PluginInstallRecord;
  verifyOwnership: boolean;
  deps: ActivateSetupInferenceDeps;
}): Promise<void> {
  if (params.verifyOwnership && (await isCodexInstallRecordPersisted(params.record, params.deps))) {
    return;
  }
  if (params.record.source !== "npm" || !params.record.installPath?.trim()) {
    return;
  }
  try {
    // Never delete an unowned generation: recovery/startup cleanup skips the
    // marker, a successful install commit clears it, and later install/GC may
    // safely reuse or remove the bytes.
    const markRetained =
      params.deps.markRetainedManagedNpmInstall ??
      (await import("../plugins/managed-npm-retention.js")).markRetainedManagedNpmInstall;
    const marked = await markRetained({
      packageDir: params.record.installPath,
      pluginId: "codex",
      reason: "crestodian-inference-activation-not-committed",
    });
    if (!marked) {
      log.warn("Could not retain the uncommitted Codex runtime package generation.");
    }
  } catch {
    // Retention is best effort and marker-after-adoption is non-destructive.
    // A later install or GC may still reuse or remove the unowned generation.
    log.warn("Could not retain the uncommitted Codex runtime package generation.");
  } finally {
    await clearUnownedCodexInstallCaches(params.deps);
  }
}

async function clearUnownedCodexInstallCaches(deps: ActivateSetupInferenceDeps): Promise<void> {
  try {
    const clearInstallRecords =
      deps.clearLoadInstalledPluginIndexInstallRecordsCache ??
      (await import("../plugins/installed-plugin-index-records.js"))
        .clearLoadInstalledPluginIndexInstallRecordsCache;
    clearInstallRecords();
  } catch {
    log.warn("Could not clear the plugin install-record cache after failed Codex activation.");
  }
  try {
    const clearPluginMetadata =
      deps.clearPluginMetadataLifecycleCaches ??
      (await import("../plugins/plugin-metadata-lifecycle.js")).clearPluginMetadataLifecycleCaches;
    clearPluginMetadata();
  } catch {
    log.warn("Could not clear plugin metadata caches after failed Codex activation.");
  }
  try {
    const invalidateRuntimeDiscovery =
      deps.invalidatePluginRuntimeDiscoveryAfterConfigMutation ??
      (await import("../plugins/registry-refresh.js"))
        .invalidatePluginRuntimeDiscoveryAfterConfigMutation;
    await invalidateRuntimeDiscovery({ logger: log });
  } catch {
    log.warn("Could not clear plugin runtime discovery after failed Codex activation.");
  }
}

function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergePatchConflicts(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isMergePatchObject(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  const baseIsObject = isMergePatchObject(base);
  const currentIsObject = isMergePatchObject(current);
  if (baseIsObject !== currentIsObject) {
    return true;
  }
  if (!baseIsObject && !currentIsObject && !isDeepStrictEqual(base, current)) {
    return true;
  }
  const baseRecord = baseIsObject ? base : {};
  const currentRecord = currentIsObject ? current : {};
  return Object.entries(patch).some(([key, childPatch]) =>
    mergePatchConflicts(baseRecord[key], currentRecord[key], childPatch),
  );
}

function applyManualAuthConfig(
  config: OpenClawConfig,
  manualAuth: NonNullable<SetupInferenceTestPlan["manualAuth"]>,
  enablePlugin: typeof enablePluginInConfig = enablePluginInConfig,
): OpenClawConfig {
  let enabledConfig = config;
  if (manualAuth.pluginId) {
    const enableResult = enablePlugin(config, manualAuth.pluginId);
    if (!enableResult.enabled) {
      throw new Error(`Provider plugin ${manualAuth.pluginId} is ${enableResult.reason}.`);
    }
    enabledConfig = enableResult.config;
  }
  if (mergePatchConflicts(manualAuth.configBase, enabledConfig, manualAuth.configPatch)) {
    throw new Error(
      "Provider configuration changed during the live inference test, so the verified credential was not saved. Review the current provider settings and retry.",
    );
  }
  return applyMergePatch(enabledConfig, manualAuth.configPatch) as OpenClawConfig;
}

type ManualAuthPersistenceReceipt = {
  agentDir: string;
  profiles: Array<{
    profileId: string;
    credential: ReturnType<typeof normalizeAuthProfileCredential>;
  }>;
};

type ManualAuthProfilesReadback = "present" | "absent" | "mismatch" | "unknown";

function modelSelectionReferencesProfile(value: unknown, profileIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    const profile = splitTrailingAuthProfile(value).profile;
    return profile !== undefined && profileIds.has(profile);
  }
  if (!isMergePatchObject(value)) {
    return false;
  }
  if (modelSelectionReferencesProfile(value.primary, profileIds)) {
    return true;
  }
  return (
    Array.isArray(value.fallbacks) &&
    value.fallbacks.some((fallback) => modelSelectionReferencesProfile(fallback, profileIds))
  );
}

function configReferencesManualAuthProfiles(
  config: OpenClawConfig,
  receipt: ManualAuthPersistenceReceipt,
): boolean {
  const profileIds = new Set(receipt.profiles.map((profile) => profile.profileId));
  if (Object.keys(config.auth?.profiles ?? {}).some((profileId) => profileIds.has(profileId))) {
    return true;
  }
  if (
    Object.values(config.auth?.order ?? {}).some((order) =>
      order.some((profileId) => profileIds.has(profileId)),
    )
  ) {
    return true;
  }
  if (modelSelectionReferencesProfile(config.agents?.defaults?.model, profileIds)) {
    return true;
  }
  return (config.agents?.list ?? []).some((agent) =>
    modelSelectionReferencesProfile(agent.model, profileIds),
  );
}

function readManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): ManualAuthProfilesReadback {
  let store: ReturnType<typeof loadPersistedAuthProfileStore>;
  try {
    store = (deps.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore)(receipt.agentDir);
  } catch {
    return "unknown";
  }
  if (!store) {
    return "unknown";
  }
  if (
    receipt.profiles.every((profile) =>
      isDeepStrictEqual(store.profiles[profile.profileId], profile.credential),
    )
  ) {
    return "present";
  }
  if (receipt.profiles.every((profile) => store.profiles[profile.profileId] === undefined)) {
    return "absent";
  }
  return "mismatch";
}

function manualAuthProfilesPersisted(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): boolean {
  return readManualAuthProfiles(receipt, deps) === "present";
}

async function persistManualAuthProfiles(params: {
  profiles: ProviderAuthResult["profiles"];
  agentDir: string;
  deps: ActivateSetupInferenceDeps;
}): Promise<ManualAuthPersistenceReceipt | null> {
  const profiles = params.profiles.map((profile) => ({
    profileId: profile.profileId,
    credential: normalizeAuthProfileCredential(profile.credential),
  }));
  const receipt = { agentDir: params.agentDir, profiles };
  let collision = false;
  const update = params.deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  const updated = await update({
    agentDir: params.agentDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (store) => {
      let changed = false;
      for (const profile of profiles) {
        const existing = store.profiles[profile.profileId];
        if (existing && !isDeepStrictEqual(existing, profile.credential)) {
          collision = true;
          return false;
        }
        if (!existing) {
          store.profiles[profile.profileId] = profile.credential;
          changed = true;
        }
      }
      return changed;
    },
  });
  if (collision) {
    return null;
  }
  // The store helper can report a post-commit chmod failure as null. Read back
  // the exact unique profiles before deciding whether the transaction failed.
  return updated !== null || manualAuthProfilesPersisted(receipt, params.deps) ? receipt : null;
}

async function rollbackManualAuthProfiles(
  receipt: ManualAuthPersistenceReceipt,
  deps: ActivateSetupInferenceDeps,
): Promise<boolean> {
  const update = deps.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await update({
      agentDir: receipt.agentDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater: (store) => {
        let changed = false;
        for (const profile of receipt.profiles) {
          if (isDeepStrictEqual(store.profiles[profile.profileId], profile.credential)) {
            delete store.profiles[profile.profileId];
            changed = true;
          }
        }
        return changed;
      },
    });
    if (readManualAuthProfiles(receipt, deps) === "absent") {
      return true;
    }
  }
  return false;
}

async function runSetupInferenceTest(params: {
  plan: SetupInferenceTestPlan;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  authProfileStateMode: "read-write" | "read-only";
}): Promise<
  | { ok: true; latencyMs: number }
  | {
      ok: false;
      status: SetupInferenceFailureStatus;
      error: string;
    }
> {
  const { plan, tempDir, deps, authProfileStateMode } = params;
  // Keep these probe prefixes aligned with logging/subsystem.ts and process/command-queue.ts
  // so expected setup failures stay off the interactive TTY.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionId = `${runId}-session`;
  const sessionFile = path.join(tempDir, "session.jsonl");
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  try {
    if (plan.runner === "cli") {
      const unsupportedError = resolveToolFreeCliSetupError(plan);
      if (unsupportedError) {
        return { ok: false, status: "unavailable", error: unsupportedError };
      }
    }
    const strictProfileError = resolveStrictSetupAuthProfileError({
      plan,
      workspaceDir: tempDir,
      deps,
    });
    if (strictProfileError) {
      return { ok: false, status: "auth", error: strictProfileError };
    }

    let result: RunResult;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
        timeoutMs,
        runId,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
      })) as RunResult;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        sessionId,
        sessionKey: `temp:setup-inference:${runId}`,
        agentId: plan.agentId ?? "crestodian",
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.config,
        prompt: SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode,
        ...(plan.cleanupBundleMcpOnRunEnd ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(plan.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride }
          : {}),
        timeoutMs,
        runId,
        lane: `session:probe-setup-inference:${plan.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS },
        disableTools: true,
        modelRun: true,
        messageChannel: "crestodian",
        messageProvider: "crestodian",
      })) as RunResult;
    }
    const terminalError = extractRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return {
        ok: false,
        status: mapFailoverReasonToSetupStatus(described.reason),
        error: described.message,
      };
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      return {
        ok: false,
        status: "format",
        error: "The model started but did not send a reply. Try again or pick another option.",
      };
    }
    const winnerError = extractRunWinnerError(plan, result);
    if (winnerError) {
      return { ok: false, status: "format", error: winnerError };
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    const described = describeFailoverError(error);
    return {
      ok: false,
      status: mapFailoverReasonToSetupStatus(described.reason),
      error: described.message,
    };
  }
}
