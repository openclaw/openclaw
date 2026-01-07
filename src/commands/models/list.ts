import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import chalk from "chalk";

import { resolveClawdbotAgentDir } from "../../agents/agent-paths.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { ensureClawdbotModelsJson } from "../../agents/models-config.js";
import {
  type ClawdbotConfig,
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
} from "../../config/config.js";
import {
  getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback,
} from "../../infra/shell-env.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  formatTokenK,
  modelKey,
} from "./shared.js";

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 8;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;

const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  Boolean(
    process.stdout.isTTY && chalk.level > 0 && !opts?.json && !opts?.plain,
  );

const pad = (value: string, size: number) => value.padEnd(size);

const colorize = (
  rich: boolean,
  color: (value: string) => string,
  value: string,
) => (rich ? color(value) : value);

const formatKey = (key: string, rich: boolean) =>
  colorize(rich, chalk.yellow, key);

const formatValue = (value: string, rich: boolean) =>
  colorize(rich, chalk.white, value);

const formatKeyValue = (
  key: string,
  value: string,
  rich: boolean,
  valueColor: (value: string) => string = chalk.white,
) => `${formatKey(key, rich)}=${colorize(rich, valueColor, value)}`;

const formatSeparator = (rich: boolean) => colorize(rich, chalk.gray, " | ");

const formatTag = (tag: string, rich: boolean) => {
  if (!rich) return tag;
  if (tag === "default") return chalk.greenBright(tag);
  if (tag === "image") return chalk.magentaBright(tag);
  if (tag === "configured") return chalk.cyan(tag);
  if (tag === "missing") return chalk.red(tag);
  if (tag.startsWith("fallback#")) return chalk.yellow(tag);
  if (tag.startsWith("img-fallback#")) return chalk.yellowBright(tag);
  if (tag.startsWith("alias:")) return chalk.blue(tag);
  return chalk.gray(tag);
};

const truncate = (value: string, max: number) => {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
};

const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "missing";
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};

type ConfiguredEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
};

type ModelRow = {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
  missing: boolean;
};

const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const hasAuthForProvider = (
  provider: string,
  cfg: ClawdbotConfig,
  authStore: AuthProfileStore,
): boolean => {
  if (listProfilesForProvider(authStore, provider).length > 0) return true;
  if (resolveEnvApiKey(provider)) return true;
  if (getCustomProviderApiKey(cfg, provider)) return true;
  return false;
};

type ProviderAuthOverview = {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "missing";
    detail: string;
  };
  profiles: {
    count: number;
    oauth: number;
    apiKey: number;
    labels: string[];
  };
  env?: { value: string; source: string };
  modelsJson?: { value: string; source: string };
};

function resolveProviderAuthOverview(params: {
  provider: string;
  cfg: ClawdbotConfig;
  store: AuthProfileStore;
  modelsPath: string;
}): ProviderAuthOverview {
  const { provider, cfg, store } = params;
  const profiles = listProfilesForProvider(store, provider);
  const labels = profiles.map((profileId) => {
    const profile = store.profiles[profileId];
    if (!profile) return `${profileId}=missing`;
    if (profile.type === "api_key") {
      return `${profileId}=${maskApiKey(profile.key)}`;
    }
    const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
    const suffix =
      display === profileId
        ? ""
        : display.startsWith(profileId)
          ? display.slice(profileId.length).trim()
          : `(${display})`;
    return `${profileId}=OAuth${suffix ? ` ${suffix}` : ""}`;
  });
  const oauthCount = profiles.filter(
    (id) => store.profiles[id]?.type === "oauth",
  ).length;
  const apiKeyCount = profiles.filter(
    (id) => store.profiles[id]?.type === "api_key",
  ).length;

  const envKey = resolveEnvApiKey(provider);
  const customKey = getCustomProviderApiKey(cfg, provider);

  const effective: ProviderAuthOverview["effective"] = (() => {
    if (profiles.length > 0) {
      return {
        kind: "profiles",
        detail: shortenHomePath(resolveAuthStorePathForDisplay()),
      };
    }
    if (envKey) {
      const isOAuthEnv =
        envKey.source.includes("OAUTH_TOKEN") ||
        envKey.source.toLowerCase().includes("oauth");
      return {
        kind: "env",
        detail: isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey),
      };
    }
    if (customKey) {
      return { kind: "models.json", detail: maskApiKey(customKey) };
    }
    return { kind: "missing", detail: "missing" };
  })();

  return {
    provider,
    effective,
    profiles: {
      count: profiles.length,
      oauth: oauthCount,
      apiKey: apiKeyCount,
      labels,
    },
    ...(envKey
      ? {
          env: {
            value:
              envKey.source.includes("OAUTH_TOKEN") ||
              envKey.source.toLowerCase().includes("oauth")
                ? "OAuth (env)"
                : maskApiKey(envKey.apiKey),
            source: envKey.source,
          },
        }
      : {}),
    ...(customKey
      ? {
          modelsJson: {
            value: maskApiKey(customKey),
            source: `models.json: ${shortenHomePath(params.modelsPath)}`,
          },
        }
      : {}),
  };
}

const resolveConfiguredEntries = (cfg: ClawdbotConfig) => {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const order: string[] = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();

  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    aliasesByKey.set(key, aliases);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const key = modelKey(ref.provider, ref.model);
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push(key);
    }
    tagsByKey.get(key)?.add(tag);
  };

  addEntry(resolvedDefault, "default");

  const modelConfig = cfg.agent?.model as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const imageModelConfig = cfg.agent?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const modelFallbacks =
    typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageFallbacks =
    typeof imageModelConfig === "object"
      ? (imageModelConfig?.fallbacks ?? [])
      : [];
  const imagePrimary = imageModelConfig?.primary?.trim() ?? "";

  modelFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    const resolved = resolveModelRefFromString({
      raw: imagePrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved) addEntry(resolved.ref, "image");
  }

  imageFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agent?.models ?? {})) {
    const parsed = parseModelRef(String(key ?? ""), DEFAULT_PROVIDER);
    if (!parsed) continue;
    addEntry(parsed, "configured");
  }

  const entries: ConfiguredEntry[] = order.map((key) => {
    const slash = key.indexOf("/");
    const provider = slash === -1 ? key : key.slice(0, slash);
    const model = slash === -1 ? "" : key.slice(slash + 1);
    return {
      key,
      ref: { provider, model },
      tags: tagsByKey.get(key) ?? new Set(),
      aliases: aliasesByKey.get(key) ?? [],
    } satisfies ConfiguredEntry;
  });

  return { entries };
};

async function loadModelRegistry(cfg: ClawdbotConfig) {
  await ensureClawdbotModelsJson(cfg);
  const agentDir = resolveClawdbotAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = registry.getAll() as Model<Api>[];
  const availableModels = registry.getAvailable() as Model<Api>[];
  const availableKeys = new Set(
    availableModels.map((model) => modelKey(model.provider, model.id)),
  );
  return { registry, models, availableKeys };
}

function toModelRow(params: {
  model?: Model<Api>;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: ClawdbotConfig;
  authStore?: AuthProfileStore;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    cfg,
    authStore,
  } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl);
  const available =
    availableKeys?.has(modelKey(model.provider, model.id)) ||
    (cfg && authStore
      ? hasAuthForProvider(model.provider, cfg, authStore)
      : false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) mergedTags.delete(tag);
    }
    for (const tag of aliasTags) mergedTags.add(tag);
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}

function printModelTable(
  rows: ModelRow[],
  runtime: RuntimeEnv,
  opts: { json?: boolean; plain?: boolean } = {},
) {
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: rows.length,
          models: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.plain) {
    for (const row of rows) runtime.log(row.key);
    return;
  }

  const rich = isRich(opts);
  const header = [
    pad("Model", MODEL_PAD),
    pad("Input", INPUT_PAD),
    pad("Ctx", CTX_PAD),
    pad("Local", LOCAL_PAD),
    pad("Auth", AUTH_PAD),
    "Tags",
  ].join(" ");
  runtime.log(rich ? chalk.bold(header) : header);

  for (const row of rows) {
    const keyLabel = pad(truncate(row.key, MODEL_PAD), MODEL_PAD);
    const inputLabel = pad(row.input || "-", INPUT_PAD);
    const ctxLabel = pad(formatTokenK(row.contextWindow), CTX_PAD);
    const localText = row.local === null ? "-" : row.local ? "yes" : "no";
    const localLabel = pad(localText, LOCAL_PAD);
    const authText =
      row.available === null ? "-" : row.available ? "yes" : "no";
    const authLabel = pad(authText, AUTH_PAD);
    const tagsLabel =
      row.tags.length > 0
        ? rich
          ? row.tags.map((tag) => formatTag(tag, rich)).join(",")
          : row.tags.join(",")
        : "";

    const coloredInput = colorize(
      rich,
      row.input.includes("image") ? chalk.magenta : chalk.white,
      inputLabel,
    );
    const coloredLocal = colorize(
      rich,
      row.local === null ? chalk.gray : row.local ? chalk.green : chalk.gray,
      localLabel,
    );
    const coloredAuth = colorize(
      rich,
      row.available === null
        ? chalk.gray
        : row.available
          ? chalk.green
          : chalk.red,
      authLabel,
    );

    const line = [
      rich ? chalk.cyan(keyLabel) : keyLabel,
      coloredInput,
      ctxLabel,
      coloredLocal,
      coloredAuth,
      tagsLabel,
    ].join(" ");
    runtime.log(line);
  }
}

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const authStore = ensureAuthProfileStore();
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) return undefined;
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER);
    return parsed?.provider ?? raw.toLowerCase();
  })();

  let models: Model<Api>[] = [];
  let availableKeys: Set<string> | undefined;
  try {
    const loaded = await loadModelRegistry(cfg);
    models = loaded.models;
    availableKeys = loaded.availableKeys;
  } catch (err) {
    runtime.error(`Model registry unavailable: ${String(err)}`);
  }

  const modelByKey = new Map(
    models.map((model) => [modelKey(model.provider, model.id), model]),
  );

  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];

  if (opts.all) {
    const sorted = [...models].sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      return a.id.localeCompare(b.id);
    });

    for (const model of sorted) {
      if (providerFilter && model.provider.toLowerCase() !== providerFilter) {
        continue;
      }
      if (opts.local && !isLocalBaseUrl(model.baseUrl)) continue;
      const key = modelKey(model.provider, model.id);
      const configured = configuredByKey.get(key);
      rows.push(
        toModelRow({
          model,
          key,
          tags: configured ? Array.from(configured.tags) : [],
          aliases: configured?.aliases ?? [],
          availableKeys,
          cfg,
          authStore,
        }),
      );
    }
  } else {
    for (const entry of entries) {
      if (
        providerFilter &&
        entry.ref.provider.toLowerCase() !== providerFilter
      ) {
        continue;
      }
      const model = modelByKey.get(entry.key);
      if (opts.local && model && !isLocalBaseUrl(model.baseUrl)) continue;
      if (opts.local && !model) continue;
      rows.push(
        toModelRow({
          model,
          key: entry.key,
          tags: Array.from(entry.tags),
          aliases: entry.aliases,
          availableKeys,
          cfg,
          authStore,
        }),
      );
    }
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}

export async function modelsStatusCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const modelConfig = cfg.agent?.model as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const imageConfig = cfg.agent?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const rawModel =
    typeof modelConfig === "string"
      ? modelConfig.trim()
      : (modelConfig?.primary?.trim() ?? "");
  const resolvedLabel = `${resolved.provider}/${resolved.model}`;
  const defaultLabel = rawModel || resolvedLabel;
  const fallbacks =
    typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageModel =
    typeof imageConfig === "string"
      ? imageConfig.trim()
      : (imageConfig?.primary?.trim() ?? "");
  const imageFallbacks =
    typeof imageConfig === "object" ? (imageConfig?.fallbacks ?? []) : [];
  const aliases = Object.entries(cfg.agent?.models ?? {}).reduce<
    Record<string, string>
  >((acc, [key, entry]) => {
    const alias = entry?.alias?.trim();
    if (alias) acc[alias] = key;
    return acc;
  }, {});
  const allowed = Object.keys(cfg.agent?.models ?? {});

  const agentDir = resolveClawdbotAgentDir();
  const store = ensureAuthProfileStore();
  const modelsPath = path.join(agentDir, "models.json");

  const providersFromStore = new Set(
    Object.values(store.profiles)
      .map((profile) => profile.provider)
      .filter((p): p is string => Boolean(p)),
  );
  const providersFromConfig = new Set(
    Object.keys(cfg.models?.providers ?? {})
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const providersFromModels = new Set<string>();
  for (const raw of [
    defaultLabel,
    ...fallbacks,
    imageModel,
    ...imageFallbacks,
    ...allowed,
  ]) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (parsed?.provider) providersFromModels.add(parsed.provider);
  }

  const providersFromEnv = new Set<string>();
  // Keep in sync with resolveEnvApiKey() mappings (we want visibility even when
  // a provider isn't currently selected in config/models).
  const envProbeProviders = [
    "anthropic",
    "github-copilot",
    "google-vertex",
    "openai",
    "google",
    "groq",
    "cerebras",
    "xai",
    "openrouter",
    "zai",
    "mistral",
  ];
  for (const provider of envProbeProviders) {
    if (resolveEnvApiKey(provider)) providersFromEnv.add(provider);
  }

  const providers = Array.from(
    new Set([
      ...providersFromStore,
      ...providersFromConfig,
      ...providersFromModels,
      ...providersFromEnv,
    ]),
  )
    .map((p) => p.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const applied = getShellEnvAppliedKeys();
  const shellFallbackEnabled =
    shouldEnableShellEnvFallback(process.env) ||
    cfg.env?.shellEnv?.enabled === true;

  const providerAuth = providers
    .map((provider) =>
      resolveProviderAuthOverview({ provider, cfg, store, modelsPath }),
    )
    .filter((entry) => {
      const hasAny =
        entry.profiles.count > 0 ||
        Boolean(entry.env) ||
        Boolean(entry.modelsJson);
      return hasAny;
    });

  const providersWithOauth = providerAuth
    .filter(
      (entry) => entry.profiles.oauth > 0 || entry.env?.value === "OAuth (env)",
    )
    .map((entry) => {
      const count =
        entry.profiles.oauth || (entry.env?.value === "OAuth (env)" ? 1 : 0);
      return `${entry.provider} (${count})`;
    });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          configPath: CONFIG_PATH_CLAWDBOT,
          agentDir,
          defaultModel: defaultLabel,
          resolvedDefault: resolvedLabel,
          fallbacks,
          imageModel: imageModel || null,
          imageFallbacks,
          aliases,
          allowed,
          auth: {
            storePath: resolveAuthStorePathForDisplay(),
            shellEnvFallback: {
              enabled: shellFallbackEnabled,
              appliedKeys: applied,
            },
            providersWithOAuth: providersWithOauth,
            providers: providerAuth,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.plain) {
    runtime.log(resolvedLabel);
    return;
  }

  const rich = isRich(opts);
  const label = (value: string) => colorize(rich, chalk.cyan, value.padEnd(14));
  const displayDefault =
    rawModel && rawModel !== resolvedLabel
      ? `${resolvedLabel} (from ${rawModel})`
      : resolvedLabel;

  runtime.log(
    `${label("Config")}${colorize(rich, chalk.gray, ":")} ${colorize(rich, chalk.white, CONFIG_PATH_CLAWDBOT)}`,
  );
  runtime.log(
    `${label("Agent dir")}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      chalk.white,
      shortenHomePath(agentDir),
    )}`,
  );
  runtime.log(
    `${label("Default")}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      chalk.green,
      displayDefault,
    )}`,
  );
  runtime.log(
    `${label(`Fallbacks (${fallbacks.length || 0})`)}${colorize(
      rich,
      chalk.gray,
      ":",
    )} ${colorize(
      rich,
      fallbacks.length ? chalk.yellow : chalk.gray,
      fallbacks.length ? fallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${label("Image model")}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      imageModel ? chalk.magenta : chalk.gray,
      imageModel || "-",
    )}`,
  );
  runtime.log(
    `${label(`Image fallbacks (${imageFallbacks.length || 0})`)}${colorize(
      rich,
      chalk.gray,
      ":",
    )} ${colorize(
      rich,
      imageFallbacks.length ? chalk.magentaBright : chalk.gray,
      imageFallbacks.length ? imageFallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(
      rich,
      chalk.gray,
      ":",
    )} ${colorize(
      rich,
      Object.keys(aliases).length ? chalk.cyan : chalk.gray,
      Object.keys(aliases).length
        ? Object.entries(aliases)
            .map(([alias, target]) =>
              rich
                ? `${chalk.blue(alias)} ${chalk.gray("->")} ${chalk.white(
                    target,
                  )}`
                : `${alias} -> ${target}`,
            )
            .join(", ")
        : "-",
    )}`,
  );
  runtime.log(
    `${label(`Configured models (${allowed.length || 0})`)}${colorize(
      rich,
      chalk.gray,
      ":",
    )} ${colorize(
      rich,
      allowed.length ? chalk.white : chalk.gray,
      allowed.length ? allowed.join(", ") : "all",
    )}`,
  );

  runtime.log("");
  runtime.log(colorize(rich, chalk.bold, "Auth overview"));
  runtime.log(
    `${label("Auth store")}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      chalk.white,
      shortenHomePath(resolveAuthStorePathForDisplay()),
    )}`,
  );
  runtime.log(
    `${label("Shell env")}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      shellFallbackEnabled ? chalk.green : chalk.gray,
      shellFallbackEnabled ? "on" : "off",
    )}${
      applied.length
        ? colorize(rich, chalk.gray, ` (applied: ${applied.join(", ")})`)
        : ""
    }`,
  );
  runtime.log(
    `${label(
      `Providers w/ OAuth (${providersWithOauth.length || 0})`,
    )}${colorize(rich, chalk.gray, ":")} ${colorize(
      rich,
      providersWithOauth.length ? chalk.white : chalk.gray,
      providersWithOauth.length ? providersWithOauth.join(", ") : "-",
    )}`,
  );

  for (const entry of providerAuth) {
    const separator = formatSeparator(rich);
    const bits: string[] = [];
    bits.push(
      formatKeyValue(
        "effective",
        `${colorize(rich, chalk.magenta, entry.effective.kind)}:${colorize(
          rich,
          chalk.gray,
          entry.effective.detail,
        )}`,
        rich,
        (value) => value,
      ),
    );
    if (entry.profiles.count > 0) {
      bits.push(
        formatKeyValue(
          "profiles",
          `${entry.profiles.count} (oauth=${entry.profiles.oauth}, api_key=${entry.profiles.apiKey})`,
          rich,
        ),
      );
      if (entry.profiles.labels.length > 0) {
        bits.push(formatValue(entry.profiles.labels.join(", "), rich));
      }
    }
    if (entry.env) {
      bits.push(
        formatKeyValue(
          "env",
          `${entry.env.value}${separator}${formatKeyValue(
            "source",
            entry.env.source,
            rich,
          )}`,
          rich,
        ),
      );
    }
    if (entry.modelsJson) {
      bits.push(
        formatKeyValue(
          "models.json",
          `${entry.modelsJson.value}${separator}${formatKeyValue(
            "source",
            entry.modelsJson.source,
            rich,
          )}`,
          rich,
        ),
      );
    }
    runtime.log(`- ${chalk.bold(entry.provider)} ${bits.join(separator)}`);
  }
}
