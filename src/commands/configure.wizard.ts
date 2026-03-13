import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import {
  resolveConfiguredGuardPolicySelection,
  resolveConfiguredGuardTaxonomy,
  resolveKnownGuardTaxonomy,
  upsertGuardPolicySelection,
  upsertGuardTaxonomy,
} from "../agents/guard-model-registry.js";
import { resolveGuardModelRefCompatibility } from "../agents/guard-model.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { resolveOnboardingSecretInputString } from "../wizard/onboarding.secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { promptGuardModel } from "./guard-model-picker.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
import { noteChannelStatus, setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  printWizardHeader,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type ConfigureSectionChoice = WizardSection | "__continue";

async function resolveGatewaySecretInputForWizard(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    return await resolveOnboardingSecretInputString({
      config: params.cfg,
      value: params.value,
      path: params.path,
      env: process.env,
    });
  } catch {
    return undefined;
  }
}

function isProviderModelRef(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  const slashIdx = trimmed.indexOf("/");
  return slashIdx > 0 && slashIdx < trimmed.length - 1;
}

function parseGuardTermsCsv(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(trimmed);
  }
  return terms;
}

function requireGuardTermsCsv(label: string) {
  return (value: string) =>
    parseGuardTermsCsv(value).length > 0 ? undefined : `Enter at least one ${label}`;
}

async function ensureGuardModelTaxonomy(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  modelRef: string;
}): Promise<{ cfg: OpenClawConfig; taxonomy: { labels: string[]; categories: string[] } }> {
  const existing = resolveConfiguredGuardTaxonomy(params.cfg, params.modelRef);
  if (existing) {
    return {
      cfg: upsertGuardTaxonomy({
        cfg: params.cfg,
        modelRef: params.modelRef,
        taxonomy: existing,
      }),
      taxonomy: existing,
    };
  }

  const known = resolveKnownGuardTaxonomy(params.modelRef);
  if (known) {
    return {
      cfg: upsertGuardTaxonomy({
        cfg: params.cfg,
        modelRef: params.modelRef,
        taxonomy: known,
      }),
      taxonomy: known,
    };
  }

  const labelsRaw = await params.prompter.text({
    message: `Guard labels for ${params.modelRef} (comma-separated)`,
    placeholder: "Safe, Unsafe, Controversial",
    validate: requireGuardTermsCsv("labels"),
  });
  const categoriesRaw = await params.prompter.text({
    message: `Guard categories for ${params.modelRef} (comma-separated)`,
    placeholder: "Violent, PII, Suicide & Self-Harm, None",
    validate: requireGuardTermsCsv("categories"),
  });
  const taxonomy = {
    labels: parseGuardTermsCsv(labelsRaw),
    categories: parseGuardTermsCsv(categoriesRaw),
  };
  return {
    cfg: upsertGuardTaxonomy({
      cfg: params.cfg,
      modelRef: params.modelRef,
      taxonomy,
    }),
    taxonomy,
  };
}

async function promptGuardPolicySelection(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  scope: "input" | "output";
  modelRef: string;
  taxonomy: { labels: string[]; categories: string[] };
}): Promise<OpenClawConfig> {
  const existing = resolveConfiguredGuardPolicySelection(params.cfg, params.scope, params.modelRef);
  const enabledLabels =
    params.taxonomy.labels.length === 0
      ? []
      : await params.prompter.multiselect({
          message: `Enabled ${params.scope} guard labels for ${params.modelRef}`,
          options: params.taxonomy.labels.map((label) => ({
            value: label,
            label,
          })),
          initialValues: existing?.enabledLabels ?? params.taxonomy.labels,
          searchable: params.taxonomy.labels.length > 8,
        });
  const enabledCategories =
    params.taxonomy.categories.length === 0
      ? []
      : await params.prompter.multiselect({
          message: `Enabled ${params.scope} guard categories for ${params.modelRef}`,
          options: params.taxonomy.categories.map((category) => ({
            value: category,
            label: category,
          })),
          initialValues: existing?.enabledCategories ?? params.taxonomy.categories,
          searchable: params.taxonomy.categories.length > 8,
        });

  return upsertGuardPolicySelection({
    cfg: params.cfg,
    scope: params.scope,
    modelRef: params.modelRef,
    selection: {
      enabledLabels,
      enabledCategories,
    },
  });
}

async function ensureFallbackGuardPolicies(params: {
  cfg: OpenClawConfig;
  scope: "input" | "output";
  fallbackRefs: string[];
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  let nextConfig = params.cfg;
  for (const modelRef of params.fallbackRefs) {
    const ensured = await ensureGuardModelTaxonomy({
      cfg: nextConfig,
      prompter: params.prompter,
      modelRef,
    });
    nextConfig = ensured.cfg;
    const existing = resolveConfiguredGuardPolicySelection(nextConfig, params.scope, modelRef);
    if (existing) {
      continue;
    }
    nextConfig = upsertGuardPolicySelection({
      cfg: nextConfig,
      scope: params.scope,
      modelRef,
      selection: {
        enabledLabels: ensured.taxonomy.labels,
        enabledCategories: ensured.taxonomy.categories,
      },
    });
  }
  return nextConfig;
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<void> {
  const localLinks = resolveControlUiLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const configuredToken = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
  });
  const configuredPassword = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? configuredToken;
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    process.env.CLAWDBOT_GATEWAY_PASSWORD ??
    configuredPassword;

  await waitForGatewayReachable({
    url: wsUrl,
    token,
    password,
    deadlineMs: 15_000,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (err) {
    params.runtime.error(formatHealthCheckFailure(err));
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await select<ConfigureSectionChoice>({
      message: "Select sections to configure",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: "Continue",
          hint: hasSelection ? "Done" : "Skip for now",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      message: "Channels",
      options: [
        {
          value: "configure",
          label: "Configure/link",
          hint: "Add/update channels; disable unselected accounts",
        },
        {
          value: "remove",
          label: "Remove channel config",
          hint: "Delete channel tokens/settings from openclaw.json",
        },
      ],
      initialValue: "configure",
    }),
    runtime,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const {
    SEARCH_PROVIDER_OPTIONS,
    resolveExistingKey,
    hasExistingKey,
    applySearchKey,
    hasKeyInEnv,
  } = await import("./onboard-search.js");
  type SP = (typeof SEARCH_PROVIDER_OPTIONS)[number]["value"];

  const hasKeyForProvider = (provider: string): boolean => {
    const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
    if (!entry) {
      return false;
    }
    return hasExistingKey(nextConfig, provider as SP) || hasKeyInEnv(entry);
  };

  const existingProvider: string = (() => {
    const stored = existingSearch?.provider;
    if (stored && SEARCH_PROVIDER_OPTIONS.some((e) => e.value === stored)) {
      return stored;
    }
    return (
      SEARCH_PROVIDER_OPTIONS.find((e) => hasKeyForProvider(e.value))?.value ??
      SEARCH_PROVIDER_OPTIONS[0].value
    );
  })();

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Choose a provider and paste your API key.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      message: "Enable web_search?",
      initialValue:
        existingSearch?.enabled ?? SEARCH_PROVIDER_OPTIONS.some((e) => hasKeyForProvider(e.value)),
    }),
    runtime,
  );

  let nextSearch: Record<string, unknown> = {
    ...existingSearch,
    enabled: enableSearch,
  };

  if (enableSearch) {
    const providerOptions = SEARCH_PROVIDER_OPTIONS.map((entry) => {
      const configured = hasKeyForProvider(entry.value);
      return {
        value: entry.value,
        label: entry.label,
        hint: configured ? `${entry.hint} · configured` : entry.hint,
      };
    });

    const providerChoice = guardCancel(
      await select({
        message: "Choose web search provider",
        options: providerOptions,
        initialValue: existingProvider,
      }),
      runtime,
    );

    nextSearch = { ...nextSearch, provider: providerChoice };

    const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === providerChoice)!;
    const existingKey = resolveExistingKey(nextConfig, providerChoice as SP);
    const keyConfigured = hasExistingKey(nextConfig, providerChoice as SP);
    const envAvailable = entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
    const envVarNames = entry.envKeys.join(" / ");

    const keyInput = guardCancel(
      await text({
        message: keyConfigured
          ? envAvailable
            ? `${entry.label} API key (leave blank to keep current or use ${envVarNames})`
            : `${entry.label} API key (leave blank to keep current)`
          : envAvailable
            ? `${entry.label} API key (paste it here; leave blank to use ${envVarNames})`
            : `${entry.label} API key`,
        placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
      }),
      runtime,
    );
    const key = String(keyInput ?? "").trim();

    if (key || existingKey) {
      const applied = applySearchKey(nextConfig, providerChoice as SP, (key || existingKey)!);
      nextSearch = { ...applied.tools?.web?.search };
    } else if (keyConfigured || envAvailable) {
      nextSearch = { ...nextSearch };
    } else {
      note(
        [
          "No key stored yet — web_search won't work until a key is available.",
          `Store a key here or set ${envVarNames} in the Gateway environment.`,
          `Get your API key at: ${entry.signupUrl}`,
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    }
  }

  const enableFetch = guardCancel(
    await confirm({
      message: "Enable web_fetch (keyless HTTP fetch)?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
    enabled: enableFetch,
  };

  return {
    ...nextConfig,
    tools: {
      ...nextConfig.tools,
      web: {
        ...nextConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

const GUARD_ACTION_CHOICES: { value: "block" | "redact" | "warn"; label: string; hint?: string }[] =
  [
    {
      value: "block",
      label: "Block",
      hint: "Show flagged content in a quarantine wrapper",
    },
    {
      value: "redact",
      label: "Redact",
      hint: "Replace text message but keep other payloads (like tools)",
    },
    { value: "warn", label: "Warn", hint: "Append a warning message to the original response" },
  ];

const GUARD_ERROR_CHOICES: { value: "allow" | "block"; label: string; hint?: string }[] = [
  {
    value: "allow",
    label: "Allow (fail-open)",
    hint: "If the guard model fails/times out, allow the response",
  },
  {
    value: "block",
    label: "Block (fail-closed)",
    hint: "If the guard model fails/times out, block the response",
  },
];

async function promptInputGuardModelConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const existing = nextConfig.agents?.defaults?.inputGuardModel;
  const existingPrimary = typeof existing === "string" ? existing : existing?.primary;
  const existingFallbacks =
    typeof existing === "object" && existing !== null && Array.isArray(existing.fallbacks)
      ? existing.fallbacks.filter((entry): entry is string => typeof entry === "string")
      : undefined;

  note(
    [
      "An input guard model screens user messages before they reach the LLM.",
      "If the message is flagged, it can be blocked, redacted, or returned with a warning.",
      "Example providers: chutes/Qwen/Qwen3Guard-Gen-0.6B, openai/gpt-4o-mini",
    ].join("\n"),
    "Input Guard Model",
  );

  const enableGuard = guardCancel(
    await confirm({
      message: "Configure an input guard model?",
      initialValue: Boolean(existingPrimary),
    }),
    runtime,
  );

  if (!enableGuard) {
    if (existingPrimary) {
      return {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            inputGuardModel: undefined,
            inputGuardPolicy: undefined,
            inputGuardModelAction: undefined,
            inputGuardModelOnError: undefined,
            inputGuardModelMaxInputChars: undefined,
          },
        },
      };
    }
    return nextConfig;
  }

  const modelSelection = await promptGuardModel({
    prompter,
    existingPrimary,
    message: "Input guard model",
  });
  const selectedModelRaw = modelSelection.model ?? existingPrimary;
  const selectedModel = selectedModelRaw?.trim();
  if (!isProviderModelRef(selectedModel)) {
    note(
      [
        "Guard model must use provider/model format (for example: chutes/Qwen/Qwen3Guard).",
        "Keeping existing guard model settings unchanged.",
      ].join("\n"),
      "Guard Model",
    );
    return nextConfig;
  }
  const compatibility = resolveGuardModelRefCompatibility(selectedModel, {
    cfg: nextConfig,
  });
  if (!compatibility.compatible) {
    note(
      [
        "Guard model must use an OpenAI-compatible provider/model (chat/completions API).",
        compatibility.api
          ? `Selected model uses "${compatibility.api}" API, which is not supported for guard screening.`
          : "Selected guard model could not be resolved to an OpenAI-compatible API.",
        "Keeping existing guard model settings unchanged.",
      ].join("\n"),
      "Guard Model",
    );
    return nextConfig;
  }

  const action = guardCancel(
    await select({
      message: "Action when input is flagged:",
      initialValue: nextConfig.agents?.defaults?.inputGuardModelAction ?? "block",
      options: GUARD_ACTION_CHOICES,
    }),
    runtime,
  );

  const onError = guardCancel(
    await select({
      message: "Behavior on API error/timeout:",
      initialValue: nextConfig.agents?.defaults?.inputGuardModelOnError ?? "allow",
      options: GUARD_ERROR_CHOICES,
    }),
    runtime,
  );

  const fallbackRefs = existingFallbacks ?? [];
  const ensuredPrimary = await ensureGuardModelTaxonomy({
    cfg: nextConfig,
    prompter,
    modelRef: selectedModel,
  });
  nextConfig = ensuredPrimary.cfg;
  nextConfig = await promptGuardPolicySelection({
    cfg: nextConfig,
    prompter,
    scope: "input",
    modelRef: selectedModel,
    taxonomy: ensuredPrimary.taxonomy,
  });
  nextConfig = await ensureFallbackGuardPolicies({
    cfg: nextConfig,
    scope: "input",
    fallbackRefs,
    prompter,
  });

  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        inputGuardModel: selectedModel
          ? existingFallbacks && existingFallbacks.length > 0
            ? { primary: selectedModel, fallbacks: existingFallbacks }
            : selectedModel
          : undefined,
        inputGuardModelAction: action,
        inputGuardModelOnError: onError,
      },
    },
  };
}

async function promptOutputGuardModelConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  // Read from outputGuardModel; fall back to legacy guardModel as initial values
  const existing =
    nextConfig.agents?.defaults?.outputGuardModel ?? nextConfig.agents?.defaults?.guardModel;
  const existingPrimary = typeof existing === "string" ? existing : existing?.primary;
  const existingFallbacks =
    typeof existing === "object" && existing !== null && Array.isArray(existing.fallbacks)
      ? existing.fallbacks.filter((entry): entry is string => typeof entry === "string")
      : undefined;

  note(
    [
      "An output guard model screens LLM replies before they are delivered.",
      "If the reply is flagged, it can be blocked, redacted, or returned with a warning.",
      "Example providers: chutes/Qwen/Qwen3Guard-Gen-0.6B, openai/gpt-4o-mini",
    ].join("\n"),
    "Output Guard Model",
  );

  const enableGuard = guardCancel(
    await confirm({
      message: "Configure an output guard model?",
      initialValue: Boolean(existingPrimary),
    }),
    runtime,
  );

  if (!enableGuard) {
    if (existingPrimary) {
      return {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            outputGuardModel: undefined,
            outputGuardPolicy: undefined,
            outputGuardModelAction: undefined,
            outputGuardModelOnError: undefined,
            outputGuardModelMaxInputChars: undefined,
            // Clear legacy fields to prevent resolveOutputGuardModelConfig fallback from keeping it enabled
            guardModel: undefined,
            guardModelAction: undefined,
            guardModelOnError: undefined,
            guardModelMaxInputChars: undefined,
          },
        },
      };
    }
    return nextConfig;
  }

  const modelSelection = await promptGuardModel({
    prompter,
    existingPrimary,
    message: "Output guard model",
  });
  const selectedModelRaw = modelSelection.model ?? existingPrimary;
  const selectedModel = selectedModelRaw?.trim();
  if (!isProviderModelRef(selectedModel)) {
    note(
      [
        "Guard model must use provider/model format (for example: chutes/Qwen/Qwen3Guard).",
        "Keeping existing guard model settings unchanged.",
      ].join("\n"),
      "Guard Model",
    );
    return nextConfig;
  }
  const compatibility = resolveGuardModelRefCompatibility(selectedModel, {
    cfg: nextConfig,
  });
  if (!compatibility.compatible) {
    note(
      [
        "Guard model must use an OpenAI-compatible provider/model (chat/completions API).",
        compatibility.api
          ? `Selected model uses "${compatibility.api}" API, which is not supported for guard screening.`
          : "Selected guard model could not be resolved to an OpenAI-compatible API.",
        "Keeping existing guard model settings unchanged.",
      ].join("\n"),
      "Guard Model",
    );
    return nextConfig;
  }

  const action = guardCancel(
    await select({
      message: "Action when output is flagged:",
      initialValue:
        nextConfig.agents?.defaults?.outputGuardModelAction ??
        nextConfig.agents?.defaults?.guardModelAction ??
        "block",
      options: GUARD_ACTION_CHOICES,
    }),
    runtime,
  );

  const onError = guardCancel(
    await select({
      message: "Behavior on API error/timeout:",
      initialValue:
        nextConfig.agents?.defaults?.outputGuardModelOnError ??
        nextConfig.agents?.defaults?.guardModelOnError ??
        "allow",
      options: GUARD_ERROR_CHOICES,
    }),
    runtime,
  );

  const fallbackRefs = existingFallbacks ?? [];
  const ensuredPrimary = await ensureGuardModelTaxonomy({
    cfg: nextConfig,
    prompter,
    modelRef: selectedModel,
  });
  nextConfig = ensuredPrimary.cfg;
  nextConfig = await promptGuardPolicySelection({
    cfg: nextConfig,
    prompter,
    scope: "output",
    modelRef: selectedModel,
    taxonomy: ensuredPrimary.taxonomy,
  });
  nextConfig = await ensureFallbackGuardPolicies({
    cfg: nextConfig,
    scope: "output",
    fallbackRefs,
    prompter,
  });

  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        outputGuardModel: selectedModel
          ? existingFallbacks && existingFallbacks.length > 0
            ? { primary: selectedModel, fallbacks: existingFallbacks }
            : selectedModel
          : undefined,
        outputGuardModelAction: action,
        outputGuardModelOnError: onError,
      },
    },
  };
}

async function promptGuardModelConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  nextConfig = await promptInputGuardModelConfig(nextConfig, runtime, prompter);
  nextConfig = await promptOutputGuardModelConfig(nextConfig, runtime, prompter);
  return nextConfig;
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    printWizardHeader(runtime);
    intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
    const baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
    });
    const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
    });
    const localProbe = await probeGatewayReachable({
      url: localUrl,
      token:
        process.env.OPENCLAW_GATEWAY_TOKEN ??
        process.env.CLAWDBOT_GATEWAY_TOKEN ??
        baseLocalProbeToken,
      password:
        process.env.OPENCLAW_GATEWAY_PASSWORD ??
        process.env.CLAWDBOT_GATEWAY_PASSWORD ??
        baseLocalProbePassword,
    });
    const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
    const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
    });
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          url: remoteUrl,
          token: baseRemoteProbeToken,
        })
      : null;

    const mode = guardCancel(
      await select({
        message: "Where will the Gateway run?",
        options: [
          {
            value: "local",
            label: "Local (this machine)",
            hint: localProbe.ok
              ? `Gateway reachable (${localUrl})`
              : `No gateway detected (${localUrl})`,
          },
          {
            value: "remote",
            label: "Remote (info-only)",
            hint: !remoteUrl
              ? "No remote URL configured yet"
              : remoteProbe?.ok
                ? `Gateway reachable (${remoteUrl})`
                : `Configured but unreachable (${remoteUrl})`,
          },
        ],
      }),
      runtime,
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(remoteConfig);
      logConfigUpdated(runtime);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(nextConfig);
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await text({
          message: "Workspace directory",
          initialValue: workspaceDir,
        }),
        runtime,
      );
      workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          note(
            [
              `Existing workspace detected at ${workspaceDir}`,
              "Existing files are preserved. Missing templates may be created, never overwritten.",
            ].join("\n"),
            "Existing workspace",
          );
        }
      }
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessions(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      await noteChannelStatus({ cfg: nextConfig, prompter });
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
          skipConfirm: true,
          skipStatusNote: true,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await text({
          message: "Gateway port for service install",
          initialValue: String(gatewayPort),
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime);
      }

      if (selected.includes("guard-model")) {
        nextConfig = await promptGuardModelConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemon({ runtime, port: gatewayPort });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime);
          await persistConfig();
        }

        if (choice === "guard-model") {
          nextConfig = await promptGuardModelConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemon({
            runtime,
            port: gatewayPort,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No changes selected.");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
    });
    // Try both new and old passwords since gateway may still have old config.
    const newPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const oldPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: baseConfig,
        value: baseConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const token =
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.CLAWDBOT_GATEWAY_TOKEN ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.token,
        path: "gateway.auth.token",
      }));

    let gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    // If new password failed and it's different from old password, try old too.
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        url: links.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "Gateway: reachable"
      : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    note(
      [
        `Web UI: ${links.httpUrl}`,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro("Configure complete.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
