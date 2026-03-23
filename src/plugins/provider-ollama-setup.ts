import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../agents/ollama-defaults.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
} from "../agents/ollama-models.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "../wizard/prompts.js";
import { applyAgentDefaultModelPrimary } from "./provider-onboarding-config.js";
import { isRemoteEnvironment, openUrl } from "./setup-browser.js";
import type { ProviderAuthOptionBag } from "./types.js";

export { OLLAMA_DEFAULT_BASE_URL } from "../agents/ollama-defaults.js";
export const OLLAMA_DEFAULT_MODEL = "glm-4.7-flash";

const OLLAMA_SUGGESTED_MODELS_LOCAL = ["glm-4.7-flash"];
const OLLAMA_SUGGESTED_MODELS_CLOUD = ["kimi-k2.5:cloud", "minimax-m2.5:cloud", "glm-5:cloud"];
type OllamaMode = "remote" | "local";
type OllamaSetupOptions = ProviderAuthOptionBag & {
  customBaseUrl?: string;
  customModelId?: string;
};

function normalizeOllamaModelName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("ollama/")) {
    const withoutPrefix = trimmed.slice("ollama/".length).trim();
    return withoutPrefix || undefined;
  }
  return trimmed;
}

function isOllamaCloudModel(modelName: string | undefined): boolean {
  return Boolean(modelName?.trim().toLowerCase().endsWith(":cloud"));
}

function formatOllamaPullStatus(status: string): { text: string; hidePercent: boolean } {
  const trimmed = status.trim();
  const partStatusMatch = trimmed.match(/^([a-z-]+)\s+(?:sha256:)?[a-f0-9]{8,}$/i);
  if (partStatusMatch) {
    return { text: `${partStatusMatch[1]} part`, hidePercent: false };
  }
  if (/^verifying\b.*\bdigest\b/i.test(trimmed)) {
    return { text: "verifying digest", hidePercent: true };
  }
  return { text: trimmed, hidePercent: false };
}

type OllamaCloudAuthResult = {
  signedIn: boolean;
  signinUrl?: string;
};

/** Check if the user is signed in to Ollama cloud via /api/me. */
async function checkOllamaCloudAuth(baseUrl: string): Promise<OllamaCloudAuthResult> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const response = await fetch(`${apiBase}/api/me`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) {
      // 401 body contains { error, signin_url }
      const data = (await response.json()) as { signin_url?: string };
      return { signedIn: false, signinUrl: data.signin_url };
    }
    if (!response.ok) {
      return { signedIn: false };
    }
    return { signedIn: true };
  } catch {
    // /api/me not supported or unreachable — fail closed so cloud mode
    // doesn't silently skip auth; the caller handles the fallback.
    return { signedIn: false };
  }
}

type OllamaPullChunk = {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
};

type OllamaPullFailureKind = "http" | "no-body" | "chunk-error" | "network";
type OllamaPullResult =
  | { ok: true }
  | {
      ok: false;
      kind: OllamaPullFailureKind;
      message: string;
    };

async function pullOllamaModelCore(params: {
  baseUrl: string;
  modelName: string;
  onStatus?: (status: string, percent: number | null) => void;
}): Promise<OllamaPullResult> {
  const { onStatus } = params;
  const baseUrl = resolveOllamaApiBase(params.baseUrl);
  const modelName = normalizeOllamaModelName(params.modelName) ?? params.modelName.trim();
  try {
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (!response.ok) {
      return {
        ok: false,
        kind: "http",
        message: `Failed to download ${modelName} (HTTP ${response.status})`,
      };
    }
    if (!response.body) {
      return {
        ok: false,
        kind: "no-body",
        message: `Failed to download ${modelName} (no response body)`,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const layers = new Map<string, { total: number; completed: number }>();

    const parseLine = (line: string): OllamaPullResult => {
      const trimmed = line.trim();
      if (!trimmed) {
        return { ok: true };
      }
      try {
        const chunk = JSON.parse(trimmed) as OllamaPullChunk;
        if (chunk.error) {
          return {
            ok: false,
            kind: "chunk-error",
            message: `Download failed: ${chunk.error}`,
          };
        }
        if (!chunk.status) {
          return { ok: true };
        }
        if (chunk.total && chunk.completed !== undefined) {
          layers.set(chunk.status, { total: chunk.total, completed: chunk.completed });
          let totalSum = 0;
          let completedSum = 0;
          for (const layer of layers.values()) {
            totalSum += layer.total;
            completedSum += layer.completed;
          }
          const percent = totalSum > 0 ? Math.round((completedSum / totalSum) * 100) : null;
          onStatus?.(chunk.status, percent);
        } else {
          onStatus?.(chunk.status, null);
        }
      } catch {
        // Ignore malformed lines from streaming output.
      }
      return { ok: true };
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseLine(line);
        if (!parsed.ok) {
          return parsed;
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      const parsed = parseLine(trailing);
      if (!parsed.ok) {
        return parsed;
      }
    }

    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: "network",
      message: `Failed to download ${modelName}: ${reason}`,
    };
  }
}

/** Pull a model from Ollama, streaming progress updates. */
async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  prompter: WizardPrompter,
): Promise<boolean> {
  const spinner = prompter.progress(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({
    baseUrl,
    modelName,
    onStatus: (status, percent) => {
      const displayStatus = formatOllamaPullStatus(status);
      if (displayStatus.hidePercent) {
        spinner.update(`Downloading ${modelName} - ${displayStatus.text}`);
      } else {
        spinner.update(`Downloading ${modelName} - ${displayStatus.text} - ${percent ?? 0}%`);
      }
    },
  });
  if (!result.ok) {
    spinner.stop(result.message);
    return false;
  }
  spinner.stop(`Downloaded ${modelName}`);
  return true;
}

async function pullOllamaModelNonInteractive(
  baseUrl: string,
  modelName: string,
  runtime: RuntimeEnv,
): Promise<boolean> {
  runtime.log(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({ baseUrl, modelName });
  if (!result.ok) {
    runtime.error(result.message);
    return false;
  }
  runtime.log(`Downloaded ${modelName}`);
  return true;
}

function buildOllamaModelsConfig(
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
) {
  return modelNames.map((name) =>
    buildOllamaModelDefinition(name, discoveredModelsByName?.get(name)?.contextWindow),
  );
}

function applyOllamaProviderConfig(
  cfg: OpenClawConfig,
  baseUrl: string,
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
): OpenClawConfig {
  return {
    ...cfg,
    models: {
      ...cfg.models,
      mode: cfg.models?.mode ?? "merge",
      providers: {
        ...cfg.models?.providers,
        ollama: {
          baseUrl,
          api: "ollama",
          apiKey: "OLLAMA_API_KEY", // pragma: allowlist secret
          models: buildOllamaModelsConfig(modelNames, discoveredModelsByName),
        },
      },
    },
  };
}

async function storeOllamaCredential(agentDir?: string): Promise<void> {
  await upsertAuthProfileWithLock({
    profileId: "ollama:default",
    credential: { type: "api_key", provider: "ollama", key: "ollama-local" },
    agentDir,
  });
}

/**
 * Interactive: prompt for base URL, discover models, configure provider.
 * Model selection is handled by the standard model picker downstream.
 */
export async function promptAndConfigureOllama(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<{ config: OpenClawConfig }> {
  const { prompter } = params;

  // 1. Prompt base URL
  const baseUrlRaw = await prompter.text({
    message: "Ollama base URL",
    initialValue: OLLAMA_DEFAULT_BASE_URL,
    placeholder: OLLAMA_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const configuredBaseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const baseUrl = resolveOllamaApiBase(configuredBaseUrl);

  // 2. Check reachability
  const { reachable, models } = await fetchOllamaModels(baseUrl);

  if (!reachable) {
    await prompter.note(
      [
        `Ollama could not be reached at ${baseUrl}.`,
        "Download it at https://ollama.com/download",
        "",
        "Start Ollama and re-run setup.",
      ].join("\n"),
      "Ollama",
    );
    throw new WizardCancelledError("Ollama not reachable");
  }

  const enrichedModels = await enrichOllamaModelsWithContext(baseUrl, models.slice(0, 50));
  const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
  const modelNames = models.map((m) => m.name);

  // 3. Mode selection
  const mode = (await prompter.select({
    message: "Ollama mode",
    options: [
      { value: "remote", label: "Cloud + Local", hint: "Ollama cloud models + local models" },
      { value: "local", label: "Local", hint: "Local models only" },
    ],
  })) as OllamaMode;

  // 4. Cloud auth — check /api/me upfront for remote (cloud+local) mode
  let cloudAuthVerified = false;
  if (mode === "remote") {
    const authResult = await checkOllamaCloudAuth(baseUrl);
    if (!authResult.signedIn) {
      if (authResult.signinUrl) {
        if (!isRemoteEnvironment()) {
          await openUrl(authResult.signinUrl);
        }
        await prompter.note(
          ["Sign in to Ollama Cloud:", authResult.signinUrl].join("\n"),
          "Ollama Cloud",
        );
        const confirmed = await prompter.confirm({
          message: "Have you signed in?",
        });
        if (!confirmed) {
          throw new WizardCancelledError("Ollama cloud sign-in cancelled");
        }
        // Re-check after user claims sign-in
        const recheck = await checkOllamaCloudAuth(baseUrl);
        if (!recheck.signedIn) {
          throw new WizardCancelledError("Ollama cloud sign-in required");
        }
        cloudAuthVerified = true;
      } else {
        // No signin URL available (older server, unreachable /api/me, or custom gateway).
        await prompter.note(
          [
            "Could not verify Ollama Cloud authentication.",
            "Cloud models may not work until you sign in at https://ollama.com.",
          ].join("\n"),
          "Ollama Cloud",
        );
        const continueAnyway = await prompter.confirm({
          message: "Continue without cloud auth?",
        });
        if (!continueAnyway) {
          throw new WizardCancelledError("Ollama cloud auth could not be verified");
        }
        // Cloud auth unverified — fall back to local defaults so the model
        // picker doesn't steer toward cloud models that may fail.
      }
    } else {
      cloudAuthVerified = true;
    }
  }

  // 5. Model ordering — suggested models first.
  // Use cloud defaults only when auth was actually verified; otherwise fall
  // back to local defaults so the user isn't steered toward cloud models
  // that may fail at runtime.
  const suggestedModels =
    mode === "local" || !cloudAuthVerified
      ? OLLAMA_SUGGESTED_MODELS_LOCAL
      : OLLAMA_SUGGESTED_MODELS_CLOUD;
  const orderedModelNames = [
    ...suggestedModels,
    ...modelNames.filter((name) => !suggestedModels.includes(name)),
  ];

  const config = applyOllamaProviderConfig(
    params.cfg,
    baseUrl,
    orderedModelNames,
    discoveredModelsByName,
  );
  return { config };
}

/** Non-interactive: auto-discover models and configure provider. */
export async function configureOllamaNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OllamaSetupOptions;
  runtime: RuntimeEnv;
}): Promise<OpenClawConfig> {
  const { opts, runtime } = params;
  const configuredBaseUrl = (opts.customBaseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const baseUrl = resolveOllamaApiBase(configuredBaseUrl);

  const { reachable, models } = await fetchOllamaModels(baseUrl);
  const explicitModel = normalizeOllamaModelName(opts.customModelId);

  if (!reachable) {
    runtime.error(
      [
        `Ollama could not be reached at ${baseUrl}.`,
        "Download it at https://ollama.com/download",
      ].join("\n"),
    );
    runtime.exit(1);
    return params.nextConfig;
  }

  await storeOllamaCredential();

  const enrichedModels = await enrichOllamaModelsWithContext(baseUrl, models.slice(0, 50));
  const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
  const modelNames = models.map((m) => m.name);

  // Apply local suggested model ordering.
  const suggestedModels = OLLAMA_SUGGESTED_MODELS_LOCAL;
  const orderedModelNames = [
    ...suggestedModels,
    ...modelNames.filter((name) => !suggestedModels.includes(name)),
  ];

  const requestedDefaultModelId = explicitModel ?? suggestedModels[0];
  let pulledRequestedModel = false;
  const availableModelNames = new Set(modelNames);
  const requestedCloudModel = isOllamaCloudModel(requestedDefaultModelId);

  if (requestedCloudModel) {
    availableModelNames.add(requestedDefaultModelId);
  }

  // Pull if model not in discovered list and Ollama is reachable
  if (!requestedCloudModel && !modelNames.includes(requestedDefaultModelId)) {
    pulledRequestedModel = await pullOllamaModelNonInteractive(
      baseUrl,
      requestedDefaultModelId,
      runtime,
    );
    if (pulledRequestedModel) {
      availableModelNames.add(requestedDefaultModelId);
    }
  }

  let allModelNames = orderedModelNames;
  let defaultModelId = requestedDefaultModelId;
  if (
    (pulledRequestedModel || requestedCloudModel) &&
    !allModelNames.includes(requestedDefaultModelId)
  ) {
    allModelNames = [...allModelNames, requestedDefaultModelId];
  }
  if (!availableModelNames.has(requestedDefaultModelId)) {
    if (availableModelNames.size > 0) {
      const firstAvailableModel =
        allModelNames.find((name) => availableModelNames.has(name)) ??
        Array.from(availableModelNames)[0];
      defaultModelId = firstAvailableModel;
      runtime.log(
        `Ollama model ${requestedDefaultModelId} was not available; using ${defaultModelId} instead.`,
      );
    } else {
      runtime.error(
        [
          `No Ollama models are available at ${baseUrl}.`,
          "Pull a model first, then re-run setup.",
        ].join("\n"),
      );
      runtime.exit(1);
      return params.nextConfig;
    }
  }

  const config = applyOllamaProviderConfig(
    params.nextConfig,
    baseUrl,
    allModelNames,
    discoveredModelsByName,
  );
  const modelRef = `ollama/${defaultModelId}`;
  runtime.log(`Default Ollama model: ${defaultModelId}`);
  return applyAgentDefaultModelPrimary(config, modelRef);
}

/** Pull the configured default Ollama model if it isn't already available locally. */
export async function ensureOllamaModelPulled(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
}): Promise<void> {
  if (!params.model.startsWith("ollama/")) {
    return;
  }
  const baseUrl = params.config.models?.providers?.ollama?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  const modelName = params.model.slice("ollama/".length);
  if (isOllamaCloudModel(modelName)) {
    return;
  }
  const { models } = await fetchOllamaModels(baseUrl);
  if (models.some((m) => m.name === modelName)) {
    return;
  }
  const pulled = await pullOllamaModel(baseUrl, modelName, params.prompter);
  if (!pulled) {
    throw new WizardCancelledError("Failed to download selected Ollama model");
  }
}
