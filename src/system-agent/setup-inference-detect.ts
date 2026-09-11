import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import {
  choiceMatchesCredential,
  listSetupInferenceAuthOptions,
  listSetupInferenceEnableOptions,
  listSetupInferenceInstallOptions,
  listSetupInferenceManualProviders,
  listSetupInferencePrepareOptions,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type DetectSetupInferenceDeps,
  type SetupInferenceCandidate,
  type SetupInferenceDetection,
  type SetupInferenceUnavailableCandidate,
  invalidSetupConfigError,
  setupInferenceLog,
  resolveCandidatePresentation,
  resolveSetupInferenceWorkspace,
  toProviderAutoSetupKind,
  toSavedAuthSetupKind,
} from "./setup-inference-core.js";
import {
  listSetupNativeSessionCatalogs,
  requiresSetupNativeSessionCatalogConsent,
} from "./setup-native-session-catalogs.js";

async function listSavedSetupInferenceCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspace: string;
  choices: readonly ProviderAuthChoiceMetadata[];
  deps: DetectSetupInferenceDeps;
  signal: AbortSignal;
}): Promise<SetupInferenceCandidate[]> {
  const { loadProviderAuthMethod } = await import("./setup-inference-credentials.js");
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const candidates: SetupInferenceCandidate[] = [];
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    params.signal.throwIfAborted();
    const saved = credential.setup;
    if (!saved && params.cfg.auth?.profiles?.[profileId]) {
      continue;
    }
    const choice = saved?.authChoice
      ? params.choices.find(
          (entry) => entry.choiceId === saved.authChoice && entry.pluginId === saved.pluginId,
        )
      : params.choices.find((entry) => choiceMatchesCredential(entry, credential));
    let modelRef = saved?.modelRef;
    if (!modelRef && choice) {
      const loaded = await loadProviderAuthMethod({ ...params, choice });
      params.signal.throwIfAborted();
      if (!("error" in loaded)) {
        modelRef = loaded.method.starterModel;
      }
    }
    if (!modelRef) {
      continue;
    }
    candidates.push({
      kind: toSavedAuthSetupKind(profileId),
      modelRef,
      brandId: choice?.providerId ?? credential.provider,
      label: `Saved ${choice?.choiceLabel ?? credential.provider} sign-in`,
      detail: credential.setup?.replacement
        ? "Saved but inactive. Test this sign-in again, then choose whether to activate it."
        : "Verify this saved sign-in to use it. No new sign-in is needed.",
      recommended: false,
      credentials: true,
      ...(choice?.icon ? { icon: choice.icon } : {}),
      ...(choice?.website ? { website: choice.website } : {}),
    });
  }
  return candidates;
}

function resolveConfiguredCandidateKind(
  config: Parameters<typeof resolveModelRuntimePolicy>[0]["config"],
  modelRef: string | undefined,
  agentId?: string,
): SetupInferenceCandidate["kind"] | undefined {
  if (!modelRef) {
    return undefined;
  }
  const ref = parseProviderModelRef(modelRef);
  if (!ref) {
    return undefined;
  }
  const runtime = normalizeOptionalAgentRuntimeId(
    resolveModelRuntimePolicy({
      config,
      provider: ref.provider,
      modelId: ref.model,
      agentId: resolveAmbientOwnerAgentId(config ?? {}, agentId),
    }).policy?.id,
  );
  if (runtime === "codex") {
    return "codex-cli";
  }
  if (runtime === "claude-cli") {
    return "claude-cli";
  }
  return undefined;
}

async function prepareSetupInferenceOptions(deps: DetectSetupInferenceDeps, agentId?: string) {
  const { readConfigFileSnapshotWithPluginMetadata } = await import("../config/config.js");
  const { snapshot, pluginMetadataSnapshot } = await readConfigFileSnapshotWithPluginMetadata();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const targetAgentId = resolveAmbientOwnerAgentId(cfg, agentId);
  const workspace = resolveSetupInferenceWorkspace(snapshot);
  const allAuthChoices = (
    deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: cfg,
    workspaceDir: workspace,
    metadataSnapshot: pluginMetadataSnapshot,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  const authChoices = allAuthChoices.filter(
    (choice) => (deps.enablePluginInConfig ?? enablePluginInConfig)(cfg, choice.pluginId).enabled,
  );
  const disabledAuthChoices = allAuthChoices.filter((choice) => !authChoices.includes(choice));
  const setupComplete = Boolean(resolveAgentEffectiveModelPrimary(cfg, targetAgentId));
  const installOptions = listSetupInferenceInstallOptions(
    resolveProviderInstallCatalogEntries({
      config: cfg,
      workspaceDir: workspace,
      includeUntrustedWorkspacePlugins: false,
    }),
    authChoices,
  );
  const authOptions = [
    ...listSetupInferenceAuthOptions(authChoices),
    ...listSetupInferenceEnableOptions(disabledAuthChoices),
    ...installOptions,
    {
      id: "custom-api-key",
      brandId: "custom",
      label: "Custom OpenAI/Anthropic-compatible endpoint",
      hint: "Connect a compatible endpoint running from this Gateway host.",
      kind: "custom" as const,
      featured: false,
    },
  ].filter(
    (option, index, options) => options.findIndex((entry) => entry.id === option.id) === index,
  );
  const nativeSessionCatalogs = listSetupNativeSessionCatalogs({
    config: cfg,
    workspaceDir: workspace,
    metadataSnapshot: pluginMetadataSnapshot,
  });
  const manual = {
    manualProviders: listSetupInferenceManualProviders(authChoices),
    authOptions,
    prepareOptions: listSetupInferencePrepareOptions(authChoices),
    nativeSessionCatalogs,
    nativeSessionCatalogPreferenceRequired: requiresSetupNativeSessionCatalogConsent({
      configExists: snapshot.exists,
      config: snapshot.sourceConfig ?? snapshot.config,
      catalogs: nativeSessionCatalogs,
    }),
    workspace,
    // Declining discovery must not turn an already configured install into fresh setup.
    setupComplete,
  };
  return { cfg, targetAgentId, authChoices, manual };
}

/** Manual setup options use only config and manifests, never machine or credential probes. */
export async function listManualSetupInferenceOptions(
  deps: DetectSetupInferenceDeps = {},
  agentId?: string,
): Promise<
  Pick<
    SetupInferenceDetection,
    "manualProviders" | "authOptions" | "prepareOptions" | "workspace" | "setupComplete"
  >
> {
  return (await prepareSetupInferenceOptions(deps, agentId)).manual;
}

export async function detectSetupInference(
  deps: DetectSetupInferenceDeps = {},
  agentId?: string,
): Promise<SetupInferenceDetection> {
  const prepared = await prepareSetupInferenceOptions(deps, agentId);
  let partial: SetupInferenceDetection = {
    ...prepared.manual,
    candidates: [],
    unavailableCandidates: [],
    recommendedInstalls: listRecommendedToolInstalls(),
  };
  const controller = new AbortController();
  // Preserve the shipped 30s discovery allowance.
  // This bounds asynchronous discovery; synchronous plugin loading shares the event loop.
  const timeoutMs = 30_000;
  return await new Promise<SetupInferenceDetection>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error("Setup inference discovery timed out"));
      setupInferenceLog.warn(
        `Setup inference detection timed out after ${timeoutMs}ms; returning partial detection.`,
      );
      resolve(partial);
    }, timeoutMs);
    void discoverSetupInference(prepared, deps, controller.signal, (detection) => {
      partial = detection;
      deps.onPartial?.(detection);
    }).then(
      (detection) => {
        clearTimeout(timer);
        resolve(detection);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toErrorObject(error, "Setup inference discovery failed"));
      },
    );
  });
}

async function discoverSetupInference(
  {
    cfg,
    targetAgentId,
    authChoices,
    manual,
  }: Awaited<ReturnType<typeof prepareSetupInferenceOptions>>,
  deps: DetectSetupInferenceDeps,
  signal: AbortSignal,
  onPartial: (detection: SetupInferenceDetection) => void,
): Promise<SetupInferenceDetection> {
  const { workspace } = manual;
  const savedCandidates = await listSavedSetupInferenceCandidates({
    cfg,
    agentId: targetAgentId,
    workspace,
    choices: authChoices,
    deps,
    signal,
  });
  signal.throwIfAborted();
  const partial: SetupInferenceDetection = {
    ...manual,
    candidates: savedCandidates,
    unavailableCandidates: [],
    recommendedInstalls: listRecommendedToolInstalls(),
  };
  onPartial(partial);
  const detect =
    deps.detectInferenceBackends ??
    (await import("../commands/onboard-inference.js")).detectInferenceBackends;
  const detected = await detect({ config: cfg, agentId: targetAgentId });
  signal.throwIfAborted();
  const unavailableCandidates: SetupInferenceUnavailableCandidate[] = [];
  const probe = deps.probeLocalCommand ?? (await import("./probes.js")).probeLocalCommand;
  const [pi, opencode] = await Promise.all([probe("pi"), probe("opencode")]);
  signal.throwIfAborted();
  if (pi.found && !pi.timedOut) {
    unavailableCandidates.push({
      id: "pi-cli",
      label: "Pi CLI",
      detail: "installed",
      reason:
        "Pi CLI is installed, but its whole-agent sessions require separate setup and are not a reusable guided-setup inference route.",
    });
  }
  if (opencode.found && !opencode.timedOut) {
    unavailableCandidates.push({
      id: "opencode-cli",
      label: "OpenCode CLI",
      detail: "installed",
      reason:
        "OpenCode CLI is installed, but its ACP harness requires separate setup and is not a reusable guided-setup inference route.",
    });
  }
  const configuredModel = detected.find(
    (candidate) => candidate.kind === "existing-model",
  )?.modelRef;
  const configuredCandidateKind = resolveConfiguredCandidateKind(
    cfg,
    configuredModel,
    targetAgentId,
  );
  const raw = detected.filter(
    (candidate) =>
      candidate.kind !== "gemini-cli" &&
      !(
        candidate.kind === configuredCandidateKind &&
        configuredModel &&
        areRuntimeModelRefsEquivalent(candidate.modelRef, configuredModel, { config: cfg })
      ),
  );
  const candidates: SetupInferenceCandidate[] = raw.map((candidate) =>
    // Released macOS clients require this field. Keep it false so the wire
    // contract remains decodable without expressing a provider preference.
    Object.assign(
      candidate,
      { recommended: false as const },
      resolveCandidatePresentation(candidate, authChoices),
    ),
  );
  candidates.push(...savedCandidates);
  onPartial({
    ...partial,
    candidates: [...candidates],
    unavailableCandidates,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: Boolean(configuredModel),
  });
  const discoveryChoices = authChoices.filter(
    (choice) =>
      choice.appGuidedDiscovery === true && supportsSetupTextInference(choice.onboardingScopes),
  );
  if (discoveryChoices.length > 0) {
    const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
    // Runtime metadata must be resolved with consent under this lease, not reused
    // from option preparation before awaited CLI probes could permit a replacement.
    const discovery = await withPluginLifecycleLease({ signal }, async () => {
      let discoveryConfig = cfg;
      const enabledChoices: ProviderAuthChoiceMetadata[] = [];
      for (const choice of discoveryChoices) {
        signal.throwIfAborted();
        // Keep unaccepted choices visible, but do not import their runtime during discovery.
        const enabled = await enablePluginWithCapabilityConsent(cfg, choice.pluginId, {
          workspaceDir: workspace,
        });
        signal.throwIfAborted();
        if (!enabled.enabled) {
          continue;
        }
        discoveryConfig = (deps.enablePluginInConfig ?? enablePluginInConfig)(
          discoveryConfig,
          choice.pluginId,
        ).config;
        enabledChoices.push(choice);
      }
      const providers = enabledChoices.length
        ? (
            deps.resolvePluginProviders ??
            (await import("../plugins/providers.runtime.js")).resolvePluginProvidersCore
          )({
            config: discoveryConfig,
            workspaceDir: workspace,
            mode: "setup",
            includeUntrustedWorkspacePlugins: false,
            onlyPluginIds: [...new Set(enabledChoices.map((choice) => choice.pluginId))],
          })
        : [];
      return { discoveryConfig, enabledChoices, providers };
    });
    signal.throwIfAborted();
    const discovered = await Promise.all(
      discovery.enabledChoices.map(async (choice): Promise<SetupInferenceCandidate | null> => {
        const provider = discovery.providers.find(
          (candidate) =>
            candidate.pluginId === choice.pluginId &&
            normalizeProviderId(candidate.id) === normalizeProviderId(choice.providerId),
        );
        const method = provider?.auth.find((candidate) => candidate.id === choice.methodId);
        if (!method?.appGuidedSetup) {
          return null;
        }
        try {
          const candidate = await method.appGuidedSetup.detect({
            config: discovery.discoveryConfig,
            env: process.env,
            workspaceDir: workspace,
            signal,
          });
          signal.throwIfAborted();
          if (!candidate) {
            return null;
          }
          const ref = parseProviderModelRef(candidate.modelRef);
          if (
            !ref ||
            normalizeProviderId(ref.provider) !== normalizeProviderId(choice.providerId)
          ) {
            setupInferenceLog.warn(
              `Ignoring invalid app-guided model ${candidate.modelRef} from ${choice.choiceId}.`,
            );
            return null;
          }
          return Object.assign(
            {
              kind: toProviderAutoSetupKind(choice.choiceId),
              brandId: choice.providerId,
              label: choice.choiceLabel,
              detail: candidate.detail?.trim() || "available locally",
              modelRef: candidate.modelRef,
              recommended: false as const,
              credentials: true,
            },
            choice.icon ? { icon: choice.icon } : {},
            choice.website ? { website: choice.website } : {},
          );
        } catch (error) {
          setupInferenceLog.debug(
            `App-guided discovery failed for ${choice.choiceId}: ${formatErrorMessage(error)}`,
          );
          return null;
        }
      }),
    );
    candidates.push(...discovered.filter((candidate) => candidate !== null));
  }
  return {
    ...partial,
    candidates,
    unavailableCandidates,
    ...(configuredModel ? { configuredModel } : {}),
    setupComplete: Boolean(configuredModel),
  };
}
