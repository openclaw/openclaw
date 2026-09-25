import fsSync from "node:fs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
} from "../agents/auth-profiles.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import {
  resolveApiKeyForProviderCore,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import type { HealthCheckContext, HealthFinding } from "../flows/health-checks.js";
import type { DoctorMemoryEmbeddingRuntimePayload } from "../gateway/server-methods/doctor.js";
import { resolveRememberAcrossConversations } from "../memory-host-sdk/host/config-utils.js";
import { hasConfiguredMemorySecretInput } from "../memory-host-sdk/secret.js";
import { getMissingLocalMemoryEmbeddingProviderMessage } from "../plugin-sdk/memory-core-bundled-runtime.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  resolveManifestOwnerBasePolicyBlock,
  type ManifestOwnerBasePolicyBlockReason,
} from "../plugins/manifest-owner-policy.js";
import { resolveActiveMemoryBackendConfig } from "../plugins/memory-runtime.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import {
  listProviderPolicyOwners,
  loadProviderPolicyArtifacts,
} from "../plugins/provider-public-artifacts.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import { resolveUserPath } from "../utils.js";
import {
  formatMemoryDoctorAgentMessage,
  resolveMemoryDoctorAgentScopes,
  type MemoryDoctorAgentScope,
} from "./doctor-memory-scope.js";
import {
  formatLocalRuntimeDoctorNote,
  resolveLocalProviderPolicyBlockGuidance,
} from "./doctor-memory-search-local.js";
import { noteWorkspaceMemoryHealth } from "./doctor-workspace.js";
import { isRecord } from "./doctor/shared/legacy-config-record-shared.js";

const MEMORY_EMBEDDING_PROVIDER_AUTH_IDS = new Map([
  ["github-copilot", "github-copilot"],
  ["openai", "openai"],
  ["gemini", "google"],
  ["voyage", "voyage"],
  ["mistral", "mistral"],
  ["bedrock", "amazon-bedrock"],
]);
const OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

function hasConfiguredAwsSdkAuthForProvider(provider: string, cfg: OpenClawConfig): boolean {
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
  if (providerConfig?.auth === "aws-sdk") {
    return true;
  }
  const orderedProfileIds = findNormalizedProviderValue(cfg.auth?.order, provider);
  const profileIds =
    orderedProfileIds ?? (cfg.auth?.profiles ? Object.keys(cfg.auth.profiles) : []);
  return profileIds.some((profileId) =>
    isConfiguredAwsSdkAuthProfileForProvider({ cfg, provider, profileId }),
  );
}

function isOpenAICompatibleMemoryProvider(providerId: string, cfg: OpenClawConfig): boolean {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (normalizedProviderId === OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER) {
    return true;
  }
  if (MEMORY_EMBEDDING_PROVIDER_AUTH_IDS.has(normalizedProviderId)) {
    return false;
  }
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, providerId);
  if (!providerConfig) {
    return false;
  }
  const api = normalizeProviderId(providerConfig.api ?? "");
  if (
    api === OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER ||
    OPENAI_COMPATIBLE_MODEL_APIS.has(api)
  ) {
    return true;
  }
  return !api && Boolean(normalizeOptionalString(providerConfig.baseUrl));
}

function resolveOpenAICompatibleMemoryBaseUrl(
  providerId: string,
  cfg: OpenClawConfig,
  remoteBaseUrl: string | undefined,
): string | undefined {
  return (
    normalizeOptionalString(remoteBaseUrl) ??
    normalizeOptionalString(findNormalizedProviderValue(cfg.models?.providers, providerId)?.baseUrl)
  );
}

function isKeyOptionalMemoryProvider(providerId: string, cfg: OpenClawConfig): boolean {
  return (
    providerId === "local" ||
    providerId === "ollama" ||
    providerId === "lmstudio" ||
    isOpenAICompatibleMemoryProvider(providerId, cfg)
  );
}

function hasActiveAlternateMemoryPluginSlot(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled) {
    return false;
  }
  const memorySlot = plugins.slots.memory;
  if (typeof memorySlot !== "string" || memorySlot.length === 0) {
    return false;
  }
  if (memorySlot === defaultSlotIdForKey("memory")) {
    return false;
  }
  if (plugins.deny.includes(memorySlot)) {
    return false;
  }
  if (!Object.hasOwn(plugins.entries, memorySlot)) {
    return false;
  }
  const entry = plugins.entries[memorySlot];
  if (!entry || entry.enabled === false) {
    return false;
  }
  return entry.enabled === true || entry.config !== undefined;
}

function isActiveMemoryPluginAvailable(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled || plugins.deny.includes("active-memory")) {
    return false;
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes("active-memory")) {
    return false;
  }
  const entry = plugins.entries["active-memory"];
  if (entry?.enabled === false) {
    return false;
  }
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return pluginConfig?.enabled !== false;
}

function resolveActiveMemoryConversationRecallSupport(cfg: OpenClawConfig): {
  providerSupported: boolean;
  memorySearchAllowed: boolean;
} {
  const plugins = normalizePluginsConfig(cfg.plugins);
  const providerSupported = plugins.slots.memory === defaultSlotIdForKey("memory");
  const entry = cfg.plugins?.entries?.["active-memory"];
  const config = isRecord(entry?.config) ? entry.config : undefined;
  if (!Array.isArray(config?.toolsAllow)) {
    return { providerSupported, memorySearchAllowed: true };
  }
  return {
    providerSupported,
    memorySearchAllowed: config.toolsAllow.some(
      (toolName) =>
        typeof toolName === "string" && toolName.trim().toLowerCase() === "memory_search",
    ),
  };
}

type MemorySearchHealthPath =
  | "memory.search.provider"
  | "plugins.slots.memory"
  | "memory.search.remote.baseUrl"
  | "memory.search.model";

type MemorySearchHealthReporter = (
  message: string,
  path?: MemorySearchHealthPath,
  disabled?: boolean,
) => void;

function inspectRememberAcrossConversationsHealth(params: {
  cfg: OpenClawConfig;
  agentId: string;
  report: MemorySearchHealthReporter;
}): { enabled: boolean } {
  const enabled = resolveRememberAcrossConversations(params.cfg, params.agentId);
  if (!enabled) {
    return { enabled: false };
  }
  const activeMemoryAvailable = isActiveMemoryPluginAvailable(params.cfg);
  const conversationRecallSupport = resolveActiveMemoryConversationRecallSupport(params.cfg);
  if (!activeMemoryAvailable) {
    params.report(
      `Remember across conversations is effectively enabled for agent "${params.agentId}", but the Active Memory plugin is disabled. Enable the plugin or set memory.search.rememberAcrossConversations to false.`,
    );
  }
  if (activeMemoryAvailable && !conversationRecallSupport.providerSupported) {
    params.report(
      `Remember across conversations is effectively enabled for agent "${params.agentId}", but the current memory provider does not support protected private transcript recall. Set memory.search.rememberAcrossConversations to false or use that provider's own recall path; advanced Active Memory can still use its recall tools.`,
    );
  } else if (activeMemoryAvailable && !conversationRecallSupport.memorySearchAllowed) {
    params.report(
      `Remember across conversations is effectively enabled for agent "${params.agentId}", but Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memory.search.rememberAcrossConversations to false.`,
    );
  }
  return { enabled: true };
}

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` using config-only checks where possible.
 */
type MemorySearchHealthOptions = {
  gatewayMemoryProbe?: {
    checked: boolean;
    ready: boolean;
    error?: string;
    skipped?: boolean;
    runtimeFacts?: DoctorMemoryEmbeddingRuntimePayload;
  };
  includeWorkspaceMemoryHealth?: boolean;
  skipAuthProfileResolution?: boolean;
  env?: NodeJS.ProcessEnv;
};

export async function noteMemorySearchHealth(
  cfg: OpenClawConfig,
  opts?: MemorySearchHealthOptions,
): Promise<void> {
  await inspectMemorySearchHealth(cfg, opts ?? {}, ({ text }) => note(text, "Memory search"));
}

export async function collectMemorySearchHealthFindings(
  ctx: HealthCheckContext,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  await inspectMemorySearchHealth(
    ctx.cfg,
    {
      env: ctx.env,
      includeWorkspaceMemoryHealth: false,
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    },
    ({ finding }) => {
      if (finding) {
        findings.push(finding);
      }
    },
  );
  return findings;
}

async function inspectMemorySearchHealth(
  cfg: OpenClawConfig,
  opts: MemorySearchHealthOptions,
  emit: (diagnostic: { text: string; finding: HealthFinding | null }) => void,
): Promise<void> {
  const scopes = resolveMemoryDoctorAgentScopes(cfg);
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const labelAgents = scopes.length > 1;
  for (const scope of scopes) {
    if (opts.includeWorkspaceMemoryHealth !== false) {
      await noteWorkspaceMemoryHealth(cfg, {
        agentId: scope.agentId,
        workspaceDir: scope.workspaceDir,
        labelAgent: labelAgents,
      });
    }
    const report: MemorySearchHealthReporter = (
      message,
      path = "memory.search.provider",
      disabled = false,
    ) => {
      const text = formatMemoryDoctorAgentMessage(scope.agentId, labelAgents, message);
      const [firstLine, ...details] = text.split("\n");
      const fixHint = details
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      emit({
        text,
        // Labeled disabled-agent notes have historically remained lint warnings.
        finding:
          disabled && !labelAgents
            ? null
            : {
                checkId: "core/doctor/memory-search",
                severity: "warning",
                message: (firstLine ?? text).trim(),
                path,
                ...(fixHint ? { fixHint } : {}),
              },
      });
    };
    await inspectMemorySearchHealthForAgent(
      cfg,
      scope,
      {
        ...opts,
        gatewayMemoryProbe:
          scope.agentId === defaultAgentId || opts.gatewayMemoryProbe?.skipped
            ? opts.gatewayMemoryProbe
            : undefined,
      },
      report,
    );
  }
}

async function inspectMemorySearchHealthForAgent(
  cfg: OpenClawConfig,
  scope: MemoryDoctorAgentScope,
  opts: MemorySearchHealthOptions,
  report: MemorySearchHealthReporter,
): Promise<void> {
  const { agentId, agentDir } = scope;
  const resolved = resolveMemorySearchConfig(cfg, agentId);

  if (!resolved) {
    const recallHealth = inspectRememberAcrossConversationsHealth({
      cfg,
      agentId,
      report,
    });
    report(
      recallHealth.enabled
        ? `Remember across conversations is effectively enabled for agent "${agentId}", but memory search is disabled. Enable memory search or set memory.search.rememberAcrossConversations to false.`
        : "Memory search is explicitly disabled (enabled: false).",
      "memory.search.provider",
      !recallHealth.enabled,
    );
    return;
  }
  const provider = resolved.provider;
  const normalizedPlugins = normalizePluginsConfig(cfg.plugins);

  if (provider === "local" && !normalizedPlugins.enabled) {
    const policyBlock = resolveLocalProviderPolicyBlockGuidance("plugins-disabled", provider);
    report(
      [
        policyBlock.message,
        "",
        policyBlock.fix,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
    );
    return;
  }
  inspectRememberAcrossConversationsHealth({
    cfg,
    agentId,
    report,
  });
  const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved.remote?.apiKey);

  const backendConfig = resolveActiveMemoryBackendConfig({ cfg, agentId });
  if (!backendConfig) {
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      return;
    }
    if (hasActiveAlternateMemoryPluginSlot(cfg)) {
      return;
    }
    report("No active memory plugin is registered for the current config.", "plugins.slots.memory");
    return;
  }
  if (provider === "none") {
    return;
  }

  if (provider === "local") {
    const runtimeFacts = opts?.gatewayMemoryProbe?.runtimeFacts;
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      if (runtimeFacts) {
        report(formatLocalRuntimeDoctorNote(runtimeFacts));
      }
      return;
    }
    const hasExplicitLocalModel = hasLocalEmbeddings(resolved.local);
    const hasUnavailableConfiguredLocalModel =
      Boolean(normalizeOptionalString(resolved.local.modelPath)) && !hasExplicitLocalModel;
    const detail = opts?.gatewayMemoryProbe?.error?.trim();
    const gatewayDetail = detail && detail !== runtimeFacts?.loadError ? detail : null;
    const env = opts.env ?? process.env;
    const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
      config: cfg,
      env,
      includeDisabled: true,
    });
    const installedOwners = listProviderPolicyOwners(provider, manifestRegistry);
    if (installedOwners.length === 0) {
      report(getMissingLocalMemoryEmbeddingProviderMessage());
      return;
    }
    const ownerPolicies = installedOwners.map((owner) => ({
      owner,
      policyBlock: resolveManifestOwnerBasePolicyBlock({
        plugin: owner,
        normalizedConfig: normalizedPlugins,
      }),
    }));
    const eligibleOwners = ownerPolicies
      .filter(({ policyBlock }) => !policyBlock)
      .map(({ owner }) => owner);
    const policyArtifacts =
      eligibleOwners.length > 0 ? loadProviderPolicyArtifacts(eligibleOwners) : null;
    let installedOwner: (typeof installedOwners)[number];
    let ownerPolicyBlock: ManifestOwnerBasePolicyBlockReason | null;
    if (policyArtifacts) {
      installedOwner = policyArtifacts.owner;
      ownerPolicyBlock = null;
    } else {
      const blockedOwner = ownerPolicies.find(({ policyBlock }) => policyBlock);
      if (!blockedOwner) {
        throw new Error(`Unable to resolve the installed provider owner for "${provider}".`);
      }
      installedOwner = blockedOwner.owner;
      ownerPolicyBlock = blockedOwner.policyBlock;
    }
    const providerPolicy = policyArtifacts?.surface;
    const inspectSetup = ownerPolicyBlock
      ? undefined
      : providerPolicy?.inspectEmbeddingProviderSetup;
    const setup = inspectSetup ? await inspectSetup({ config: cfg, env, agentId, provider }) : null;
    const setupReason = setup?.reason.trim();
    const setupFix = setup?.fixHint?.trim();
    const updateFix =
      !ownerPolicyBlock && !inspectSetup
        ? `Fix: Update the installed plugin: ${formatCliCommand(`openclaw plugins update ${installedOwner.id}`)}`
        : null;
    const policyBlock = ownerPolicyBlock
      ? resolveLocalProviderPolicyBlockGuidance(ownerPolicyBlock, installedOwner.id)
      : null;
    if (
      opts?.gatewayMemoryProbe?.skipped &&
      !hasUnavailableConfiguredLocalModel &&
      !setup &&
      !policyBlock &&
      !updateFix
    ) {
      return;
    }
    const hasRuntimeFailureDetail = Boolean(gatewayDetail || runtimeFacts?.loadError);
    report(
      [
        runtimeFacts ? formatLocalRuntimeDoctorNote(runtimeFacts) : null,
        runtimeFacts ? "" : null,
        hasExplicitLocalModel
          ? 'Memory search provider is set to "local" and a local model path is configured, but local embeddings are not confirmed ready.'
          : 'Memory search provider is set to "local", but local embeddings are not confirmed ready.',
        setupReason ? `Setup: ${setupReason}` : null,
        policyBlock?.message,
        updateFix
          ? `Installed plugin "${installedOwner.id}" does not provide current local-memory setup diagnostics.`
          : null,
        gatewayDetail && gatewayDetail !== setupReason ? `Gateway probe: ${gatewayDetail}` : null,
        "",
        policyBlock?.fix ??
          updateFix ??
          (setupFix
            ? `Fix: ${setupFix}`
            : hasUnavailableConfiguredLocalModel
              ? "Fix: Set memory.search.local.modelPath to an existing GGUF file, or remove it to use the managed default."
              : hasRuntimeFailureDetail
                ? "Fix: Repair the llama.cpp server problem reported by the Gateway."
                : null),
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  if (
    isOpenAICompatibleMemoryProvider(provider, cfg) &&
    !resolveOpenAICompatibleMemoryBaseUrl(provider, cfg, resolved.remote?.baseUrl)
  ) {
    report(
      [
        `Memory search provider is set to "${provider}" but no OpenAI-compatible embeddings endpoint was configured.`,
        "Set memory.search.remote.baseUrl to the /v1 endpoint for your embeddings server.",
        "",
        "Fix:",
        `- ${formatCliCommand("openclaw config set memory.search.remote.baseUrl http://127.0.0.1:1234/v1")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "memory.search.remote.baseUrl",
    );
    return;
  }

  if (isOpenAICompatibleMemoryProvider(provider, cfg) && !normalizeOptionalString(resolved.model)) {
    report(
      [
        `Memory search provider is set to "${provider}" but no OpenAI-compatible embedding model was configured.`,
        "Set memory.search.model to the embedding model id your server expects.",
        "",
        "Fix:",
        `- ${formatCliCommand("openclaw config set memory.search.model text-embedding-bge-m3")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "memory.search.model",
    );
    return;
  }

  if (isKeyOptionalMemoryProvider(provider, cfg)) {
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      return;
    }
    // When the probe was intentionally skipped (skipped: true / checked: false
    // due to probe:false path), we have no embedding status information — do
    // not warn. A skipped probe means the user ran `openclaw doctor` without
    // --deep; it does not mean embeddings are unavailable.
    // NOTE: a transport timeout also sets checked: false, but skipped stays
    // false/absent — a timeout is a real diagnostic signal and should fall
    // through to the warning below.
    if (opts?.gatewayMemoryProbe?.skipped) {
      return;
    }
    const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
    report(
      [
        gatewayProbeWarning
          ? `Memory search provider "${provider}" is configured, but the gateway reports embeddings are not ready.`
          : `Memory search provider "${provider}" is configured, but the gateway could not confirm embeddings are ready.`,
        gatewayProbeWarning,
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  // Remote provider — check for API key.
  if (
    hasRemoteApiKey ||
    (await hasApiKeyForProvider(provider, cfg, agentDir, {
      skipProfileResolution: opts?.skipAuthProfileResolution === true,
    }))
  ) {
    return;
  }

  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    report(
      [
        `Memory search provider is set to "${provider}" but the API key was not found in the CLI environment.`,
        "The running gateway reports memory embeddings are ready for the default agent.",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
    );
    return;
  }
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
  const envVar = resolvePrimaryMemoryProviderEnvVar(provider);

  report(
    [
      `Memory search provider is set to "${provider}" but no API key was found.`,
      `Semantic recall will not work without a valid API key.`,
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      `- Set ${envVar} in your environment`,
      `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
      `- To disable: ${formatCliCommand("openclaw config set memory.search.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].join("\n"),
  );
}

/**
 * Check whether local embeddings are available.
 *
 */
function hasLocalEmbeddings(local: { modelPath?: string }): boolean {
  const modelPath = normalizeOptionalString(local.modelPath);
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: string,
  cfg: OpenClawConfig,
  agentDir: string,
  opts?: { skipProfileResolution?: boolean },
): Promise<boolean> {
  const authProviderId = MEMORY_EMBEDDING_PROVIDER_AUTH_IDS.get(provider) ?? provider;
  if (
    isSecretRef(findNormalizedProviderValue(cfg.models?.providers, authProviderId)?.apiKey) ||
    resolveEnvApiKey(authProviderId) ||
    resolveUsableCustomProviderApiKey({ cfg, provider: authProviderId })
  ) {
    return true;
  }
  if (opts?.skipProfileResolution === true) {
    if (authProviderId === "amazon-bedrock") {
      return hasConfiguredAwsSdkAuthForProvider(authProviderId, cfg);
    }
    const orderedProfileIds = findNormalizedProviderValue(cfg.auth?.order, authProviderId);
    return orderedProfileIds === undefined
      ? hasAuthProfileStoreSourceForProvider(authProviderId, agentDir)
      : hasAuthProfileStoreSourceForProvider(authProviderId, agentDir, {
          profileIds: orderedProfileIds,
        });
  }
  if (authProviderId !== "amazon-bedrock" && !hasAnyAuthProfileStoreSource(agentDir)) {
    return false;
  }
  try {
    await resolveApiKeyForProviderCore({
      provider: authProviderId,
      cfg,
      agentDir,
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePrimaryMemoryProviderEnvVar(provider: string): string {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  const authProviderId = MEMORY_EMBEDDING_PROVIDER_AUTH_IDS.get(provider);
  const envVar = authProviderId ? getProviderEnvVarsCore(authProviderId)[0] : undefined;
  return envVar ?? `${provider.toUpperCase()}_API_KEY`;
}

function buildGatewayProbeWarning(
  probe:
    | {
        checked: boolean;
        ready: boolean;
        error?: string;
        skipped?: boolean;
      }
    | undefined,
): string | null {
  if (!probe?.checked || probe.ready) {
    return null;
  }
  const detail = probe.error?.trim();
  return detail
    ? `Gateway memory probe for default agent is not ready: ${detail}`
    : "Gateway memory probe for default agent is not ready.";
}
