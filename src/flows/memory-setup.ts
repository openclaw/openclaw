import type { SecretInputMode } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type {
  EmbeddingProviderAdapter,
  EmbeddingProvider,
} from "../plugins/embedding-provider-types.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";
import { withTimeout } from "../utils/with-timeout.js";
import {
  WizardCancelledError,
  WizardNavigationError,
  type WizardPrompter,
} from "../wizard/prompts.js";

// Local HTTP providers may load an already-downloaded model before embedding.
const PROBE_TIMEOUT_MS = 150_000;
const CLOSE_TIMEOUT_MS = 1_000;

type Search = NonNullable<NonNullable<OpenClawConfig["memory"]>["search"]>;
type Remote = NonNullable<Search["remote"]>;

async function closeProvider(provider: EmbeddingProvider): Promise<void> {
  try {
    await withTimeout(
      Promise.resolve().then(() => provider.close?.()),
      CLOSE_TIMEOUT_MS,
    );
  } catch {
    // Cleanup cannot turn a failed readiness check into a surfaced provider error.
  }
}

async function probeProvider(params: {
  adapter: EmbeddingProviderAdapter;
  config: OpenClawConfig;
  agentDir?: string;
  providerId: string;
  model: string;
  search: Search;
  remote?: Remote;
}): Promise<boolean> {
  const controller = new AbortController();
  let provider: EmbeddingProvider | null = null;
  const check = async () => {
    const createOptions = {
      config: params.config,
      agentDir: params.agentDir,
      provider: params.providerId,
      model: params.model,
      remote: params.remote,
      inputType: params.search.inputType,
      queryInputType: params.search.queryInputType,
      documentInputType: params.search.documentInputType,
      dimensions: params.search.outputDimensionality,
    };
    const result = await params.adapter.create({
      ...createOptions,
      model: params.adapter.normalizeModel?.(createOptions) ?? createOptions.model,
    });
    // Creation has no abort contract; release a late result without embedding.
    if (controller.signal.aborted) {
      if (result.provider) {
        await closeProvider(result.provider);
      }
      return false;
    }
    provider = result.provider;
    if (!provider) {
      return false;
    }
    const vector = await provider.embed("ping", { signal: controller.signal, inputType: "query" });
    return Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite);
  };
  try {
    return await withTimeout(check(), PROBE_TIMEOUT_MS, {
      createError: () => {
        controller.abort();
        return new Error("embedding probe timed out");
      },
    });
  } catch {
    return false;
  } finally {
    if (provider) {
      await closeProvider(provider);
    }
  }
}

/** Optional, non-indexing embedding setup. The caller owns persistence. */
export async function runMemorySetupFlow(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  opts: { agentDir?: string; secretInputMode?: SecretInputMode } = {},
): Promise<OpenClawConfig> {
  await prompter.note(
    "Embeddings add semantic memory search. Choose a cloud provider or a running local Ollama/LM Studio server. This check sends only synthetic text, does not index memory or download models, and may load an already-downloaded model. Stored OAuth access depends on the account and model. Skipping keeps your current settings.",
    "Memory search",
  );
  if (!(await prompter.confirm({ message: "Set up memory embeddings?", initialValue: false }))) {
    return config;
  }

  let providerIds: string[];
  try {
    const [
      { loadManifestContractSnapshot, listAvailableManifestContractValues },
      { resolveConfiguredGenericEmbeddingProviderId },
    ] = await Promise.all([
      import("../plugins/manifest-contract-eligibility.js"),
      import("../plugins/embedding-provider-config.js"),
    ]);
    const ids = new Set<string>(["openai-compatible"]);
    if (config.plugins?.enabled !== false) {
      const snapshot = loadManifestContractSnapshot({ config });
      for (const id of listAvailableManifestContractValues({
        snapshot,
        contract: "embeddingProviders",
        config,
      })) {
        ids.add(id);
      }
    }
    ids.delete("local");
    ids.delete("llama-cpp");
    for (const id of Object.keys(config.models?.providers ?? {})) {
      const owner = resolveConfiguredGenericEmbeddingProviderId(id, config);
      if (owner && ids.has(owner)) {
        ids.add(id);
      }
    }
    if (
      !config.models?.providers?.["openai-compatible"]?.baseUrl &&
      !(
        config.memory?.search?.provider === "openai-compatible" &&
        config.memory.search.remote?.baseUrl
      )
    ) {
      ids.delete("openai-compatible");
    }
    providerIds = [...ids].toSorted((a, b) => a.localeCompare(b));
  } catch {
    await prompter.note(
      "Embedding providers could not be listed. Check plugin configuration and try again.",
      "Memory setup unchanged",
    );
    return config;
  }
  if (providerIds.length === 0) {
    await prompter.note(
      "No HTTP embedding providers are available. Check plugin configuration, or use the manual memory-search setup docs for managed local embeddings.",
      "Memory setup unchanged",
    );
    return config;
  }
  const previous = config.memory?.search;
  const selected = await prompter.select({
    message: "Embedding provider",
    options: providerIds.map((id) => ({ value: id, label: id })),
    initialValue:
      previous?.provider && providerIds.includes(previous.provider)
        ? previous.provider
        : providerIds[0],
  });
  let adapter: EmbeddingProviderAdapter | undefined;
  try {
    const { getEmbeddingProvider } = await import("../plugins/embedding-provider-runtime.js");
    adapter = getEmbeddingProvider(selected, config);
  } catch {
    await prompter.note(
      "The selected embedding provider could not be loaded. Check plugin configuration and try again.",
      "Memory setup unchanged",
    );
    return config;
  }
  if (!adapter || adapter.transport === "local") {
    await prompter.note(
      "This provider is unavailable for this setup flow. Use the manual memory-search setup docs for managed local embeddings.",
      "Memory setup unchanged",
    );
    return config;
  }

  const sameProvider = selected === previous?.provider;
  const initialModel = (sameProvider ? previous?.model : undefined) || adapter.defaultModel || "";
  const model = (
    await prompter.text({
      message: "Embedding model ID",
      initialValue: initialModel || undefined,
      placeholder: "Enter the model ID accepted by this provider",
      validate: (value) => (value.trim() ? undefined : "Enter an embedding model ID."),
    })
  ).trim();
  if (!model) {
    await prompter.note("An embedding model ID is required.", "Memory setup unchanged");
    return config;
  }

  const remoteBase: Remote = sameProvider
    ? { ...previous?.remote }
    : previous?.remote?.batch
      ? { batch: previous.remote.batch }
      : {};
  const credentialChoice = await prompter.select({
    message: "Embedding credential",
    options: [
      {
        value: "existing",
        label: "Use existing credentials / no key",
        hint: "Saved key, provider auth, environment, or unauthenticated local server",
      },
      ...(opts.secretInputMode === "ref"
        ? []
        : [{ value: "key", label: "Enter API key", hint: "Masked input" }]),
      { value: "ref", label: "Use SecretRef", hint: "Store a reference, not the key" },
    ],
    initialValue:
      opts.secretInputMode === "ref" && !(sameProvider && remoteBase.apiKey) ? "ref" : "existing",
  });
  let savedKey: SecretInput | undefined;
  let probeKey: string | undefined;
  if (credentialChoice === "key" && opts.secretInputMode !== "ref") {
    const key = (
      await prompter.text({
        message: "Embedding API key",
        sensitive: true,
        validate: (value) => (value.trim() ? undefined : "Enter an API key."),
      })
    ).trim();
    savedKey = key;
    probeKey = key;
  } else if (credentialChoice === "ref") {
    try {
      const { promptSecretRefForSetup } = await import("../plugins/provider-auth-ref.js");
      const result = await promptSecretRefForSetup({
        provider: adapter.authProviderId ?? selected,
        config,
        prompter,
      });
      savedKey = result.ref;
      probeKey = result.resolvedValue;
    } catch (error) {
      if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
        throw error;
      }
      await prompter.note(
        "The secret reference could not be resolved. Check its source and try again.",
        "Memory setup unchanged",
      );
      return config;
    }
  }
  const remoteForSave: Remote = { ...remoteBase };
  if (credentialChoice !== "existing") {
    delete remoteForSave.apiKey;
  }
  if (savedKey !== undefined) {
    remoteForSave.apiKey = savedKey;
  }
  let remoteForProbe: Remote = { ...remoteForSave };
  const candidateSearch: Search = {
    ...previous,
    provider: selected,
    model,
    enabled: true,
    remote: remoteForSave,
  };
  try {
    const { resolveMemorySearchConfig } = await import("../agents/memory-search.js");
    // Validate shared defaults without letting a per-agent override mask incompatibility.
    resolveMemorySearchConfig(
      { ...config, agents: undefined, memory: { ...config.memory, search: candidateSearch } },
      "main",
    );
  } catch {
    await prompter.note(
      "The selected provider, model, or fallback is not compatible with the retained memory settings. Check the memory search configuration and try again.",
      "Memory setup unchanged",
    );
    return config;
  }
  let probeConfig: OpenClawConfig;
  try {
    const { resolveSetupSecretInputString } = await import("../wizard/setup.secret-input.js");
    if (remoteForProbe.apiKey !== undefined) {
      probeKey =
        probeKey ??
        (await resolveSetupSecretInputString({
          config,
          value: remoteForProbe.apiKey,
          path: "memory.search.remote.apiKey",
        }));
    }
    remoteForProbe = { ...remoteForProbe, ...(probeKey ? { apiKey: probeKey } : {}) };
    probeConfig = {
      ...config,
      memory: { ...config.memory, search: { ...candidateSearch, remote: remoteForProbe } },
    };
    const configuredProviderId = config.models?.providers?.[selected]
      ? selected
      : (adapter.authProviderId ?? selected);
    const configuredProvider = probeConfig.models?.providers?.[configuredProviderId];
    if (configuredProvider) {
      const [{ resolveCommandConfigWithSecrets }, { getMemoryEmbeddingCommandSecretTargetIds }] =
        await Promise.all([
          import("../cli/command-config-resolution.js"),
          import("../cli/command-secret-targets.js"),
        ]);
      const allowedPaths = new Set([
        formatConcreteConfigPath(["models", "providers", configuredProviderId, "apiKey"]),
        ...Object.keys(configuredProvider.headers ?? {}).map((name) =>
          formatConcreteConfigPath(["models", "providers", configuredProviderId, "headers", name]),
        ),
      ]);
      const resolved = await resolveCommandConfigWithSecrets({
        config: probeConfig,
        commandName: "memory embedding setup probe",
        targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
        allowedPaths,
        autoEnable: false,
      });
      probeConfig = resolved.effectiveConfig;
    }
  } catch (error) {
    if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
      throw error;
    }
    await prompter.note(
      "An existing embedding credential could not be resolved. Check its source and try again.",
      "Memory setup unchanged",
    );
    return config;
  }
  const progress = prompter.progress(
    "Checking embedding readiness (local model loading can take two minutes)…",
  );
  const ready = await probeProvider({
    adapter,
    config: probeConfig,
    agentDir: opts.agentDir,
    providerId: selected,
    model,
    search: candidateSearch,
    remote: remoteForProbe,
  });
  progress.stop(ready ? "Embedding check passed" : "Embedding check failed");
  if (!ready) {
    await prompter.note(
      "The selected embedding provider did not complete a small readiness check. Check its model, endpoint, and credentials, then try again.",
      "Memory setup unchanged",
    );
    return config;
  }
  await prompter.note(
    "Embedding readiness passed in this CLI session. The Gateway daemon must also be able to resolve any environment-based SecretRef. This changes shared memory defaults; existing per-agent overrides remain in effect. If the provider or model changes, rebuild the index explicitly with `openclaw memory index --force` before vector search resumes.",
    "Ready to save",
  );
  if (
    !(await prompter.confirm({
      message: "Save and enable these shared memory embedding defaults?",
      initialValue: false,
    }))
  ) {
    return config;
  }
  return { ...config, memory: { ...config.memory, search: candidateSearch } };
}
