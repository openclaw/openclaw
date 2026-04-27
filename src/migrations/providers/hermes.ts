import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { resolveStateDir } from "../../config/paths.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import { isRecord } from "../../utils.js";
import {
  normalizeMigrationPath,
  resolveMigrationUserPath,
  safeRelativeArchivePath,
  timestampForPath,
} from "../path-utils.js";
import type {
  MigrationAction,
  MigrationActionInput,
  MigrationDetection,
  MigrationPlan,
  MigrationPlanOptions,
  MigrationProvider,
  MigrationSourceSnapshot,
} from "../types.js";

const HERMES_PROVIDER_ID = "hermes";
const HERMES_LABEL = "Hermes";
const CONFIG_FILENAME = "config.yaml";
const ENV_FILENAME = ".env";

const HERMES_FILE_CANDIDATES = [
  "SOUL.md",
  "memories/MEMORY.md",
  "memories/USER.md",
  "auth.json",
  "state.db",
] as const;

const HERMES_DIRECTORY_CANDIDATES = [
  "skills",
  "plugins",
  "sessions",
  "logs",
  "cron",
  "mcp-tokens",
] as const;

const COMMON_SECRET_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ELEVENLABS_API_KEY",
  "BRAVE_API_KEY",
  "EXA_API_KEY",
  "TAVILY_API_KEY",
  "PERPLEXITY_API_KEY",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TELEGRAM_BOT_TOKEN",
] as const;

type HermesProviderConfig = {
  id: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  models: string[];
};

function pathExists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

async function readTextIfExists(candidate: string): Promise<string | undefined> {
  try {
    return await fs.readFile(candidate, "utf-8");
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function childRecord(
  root: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = root?.[key];
  return isRecord(value) ? value : {};
}

function sourceDirFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.HERMES_HOME?.trim()) {
    candidates.push(resolveMigrationUserPath(env.HERMES_HOME, env));
  }
  candidates.push(resolveMigrationUserPath("~/.hermes", env));
  return [...new Set(candidates.map((candidate) => normalizeMigrationPath(candidate)))];
}

async function detectHermesProfiles(sourceDir: string): Promise<string[]> {
  const profilesRootCandidates = [path.join(sourceDir, "profiles"), path.join(sourceDir, "agents")];
  const profileDirs: string[] = [];
  for (const profilesRoot of profilesRootCandidates) {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(profilesRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(profilesRoot, entry.name);
      if (await pathExists(path.join(candidate, CONFIG_FILENAME))) {
        profileDirs.push(candidate);
      }
    }
  }
  return profileDirs;
}

async function detectHermesSourceDir(sourceDir: string): Promise<MigrationDetection | null> {
  const reasons: string[] = [];
  if (await pathExists(path.join(sourceDir, CONFIG_FILENAME))) {
    reasons.push("config.yaml");
  }
  if (await pathExists(path.join(sourceDir, ENV_FILENAME))) {
    reasons.push(".env");
  }
  if (await pathExists(path.join(sourceDir, "SOUL.md"))) {
    reasons.push("SOUL.md");
  }
  if (await pathExists(path.join(sourceDir, "memories"))) {
    reasons.push("memories/");
  }
  if (reasons.length === 0) {
    return null;
  }
  return {
    providerId: HERMES_PROVIDER_ID,
    label: HERMES_LABEL,
    sourceDir,
    confidence: reasons.includes("config.yaml") ? "high" : "medium",
    reasons,
  };
}

async function inspectHermesSource(sourceDir: string): Promise<MigrationSourceSnapshot> {
  const configRaw = await readTextIfExists(path.join(sourceDir, CONFIG_FILENAME));
  const envRaw = await readTextIfExists(path.join(sourceDir, ENV_FILENAME));
  const files: Record<string, string> = {};
  const directories: Record<string, string> = {};
  const warnings: string[] = [];
  let config: Record<string, unknown> | undefined;
  if (configRaw) {
    try {
      const parsed = parseYaml(configRaw);
      if (isRecord(parsed)) {
        config = parsed;
      } else {
        warnings.push("Hermes config.yaml did not parse to an object.");
      }
    } catch (error) {
      warnings.push(`Could not parse Hermes config.yaml: ${String(error)}`);
    }
  }
  const env = envRaw ? parseDotEnv(envRaw) : undefined;

  for (const relativePath of HERMES_FILE_CANDIDATES) {
    const absolutePath = path.join(sourceDir, relativePath);
    if (await pathExists(absolutePath)) {
      files[relativePath] = absolutePath;
    }
  }
  for (const relativePath of HERMES_DIRECTORY_CANDIDATES) {
    const absolutePath = path.join(sourceDir, relativePath);
    if (await pathExists(absolutePath)) {
      directories[relativePath] = absolutePath;
    }
  }

  return {
    providerId: HERMES_PROVIDER_ID,
    sourceDir,
    label: HERMES_LABEL,
    config,
    env,
    files,
    directories,
    warnings,
  };
}

function addAction(actions: MigrationAction[], action: MigrationActionInput): void {
  actions.push({ ...action, id: `${action.category}-${actions.length + 1}` } as MigrationAction);
}

function inferModelRef(config: Record<string, unknown>): string | undefined {
  const model = childRecord(config, "model");
  return (
    asString(model.provider_model) ??
    asString(model.default) ??
    asString(model.name) ??
    asString(config.default_model) ??
    asString(config.fallback_model)
  );
}

function splitProviderModel(modelRef: string | undefined): { provider?: string; model?: string } {
  if (!modelRef) {
    return {};
  }
  const slash = modelRef.indexOf("/");
  if (slash > 0 && slash < modelRef.length - 1) {
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { model: modelRef };
}

function modelDefinition(
  modelId: string,
  providerId: string,
  baseUrl?: string,
): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    api: baseUrl ? "openai-completions" : "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    baseUrl,
    metadataSource: "models-add",
  };
}

function providerConfig(entry: HermesProviderConfig): ModelProviderConfig {
  const models = entry.models.length > 0 ? entry.models : [`${entry.id}/default`];
  return {
    baseUrl: entry.baseUrl ?? "",
    apiKey: entry.apiKeyEnv
      ? { source: "env", provider: "default", id: entry.apiKeyEnv }
      : undefined,
    api: "openai-completions",
    models: models.map((modelId) => modelDefinition(modelId, entry.id, entry.baseUrl)),
  };
}

function collectHermesProviders(snapshot: MigrationSourceSnapshot): HermesProviderConfig[] {
  const config = snapshot.config ?? {};
  const collected: HermesProviderConfig[] = [];
  const providers = childRecord(config, "providers");
  for (const [id, raw] of Object.entries(providers)) {
    if (!isRecord(raw)) {
      continue;
    }
    const baseUrl =
      asString(raw.base_url) ?? asString(raw.baseUrl) ?? asString(raw.url) ?? asString(raw.api);
    const apiKeyEnv =
      asString(raw.api_key_env) ??
      asString(raw.apiKeyEnv) ??
      asString(raw.env) ??
      `${id.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`;
    const modelValues = [
      ...asStringArray(raw.models),
      ...Object.keys(childRecord(raw, "models")),
      asString(raw.model),
    ].filter((value): value is string => Boolean(value));
    collected.push({ id, baseUrl, apiKeyEnv, models: [...new Set(modelValues)] });
  }

  const customProviders = config.custom_providers;
  if (Array.isArray(customProviders)) {
    for (const raw of customProviders) {
      if (!isRecord(raw)) {
        continue;
      }
      const name = asString(raw.name) ?? asString(raw.id);
      if (!name) {
        continue;
      }
      const baseUrl = asString(raw.base_url) ?? asString(raw.baseUrl) ?? asString(raw.url);
      const apiKeyEnv = asString(raw.api_key_env) ?? asString(raw.apiKeyEnv);
      const modelValues = [
        ...asStringArray(raw.models),
        ...Object.keys(childRecord(raw, "models")),
        asString(raw.model),
      ].filter((value): value is string => Boolean(value));
      collected.push({ id: name, baseUrl, apiKeyEnv, models: [...new Set(modelValues)] });
    }
  }

  const defaultRef = splitProviderModel(inferModelRef(config));
  if (defaultRef.provider && !collected.some((entry) => entry.id === defaultRef.provider)) {
    collected.push({
      id: defaultRef.provider,
      apiKeyEnv: `${defaultRef.provider.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`,
      models: defaultRef.model ? [defaultRef.model] : [],
    });
  }
  return collected;
}

function mapMcpServers(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const key of [
      "command",
      "args",
      "env",
      "cwd",
      "workingDirectory",
      "url",
      "transport",
      "headers",
      "connectionTimeoutMs",
    ]) {
      if (value[key] !== undefined) {
        next[key] = value[key];
      }
    }
    if (Object.keys(next).length > 0) {
      mapped[name] = next;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapSkillConfig(snapshot: MigrationSourceSnapshot): Record<string, unknown> | undefined {
  const skills = childRecord(snapshot.config, "skills");
  const config = childRecord(skills, "config");
  const entries: Record<string, unknown> = {};
  for (const [skillKey, value] of Object.entries(config)) {
    if (isRecord(value)) {
      entries[skillKey] = { config: value };
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function mapMemoryProvider(snapshot: MigrationSourceSnapshot): {
  pluginId?: string;
  config?: Record<string, unknown>;
  manual?: string;
} {
  const memory = childRecord(snapshot.config, "memory");
  const provider = asString(memory.provider);
  if (!provider) {
    return {};
  }
  if (provider === "honcho") {
    return { pluginId: "honcho", config: childRecord(memory, "honcho") };
  }
  if (provider === "builtin" || provider === "file" || provider === "files") {
    return {};
  }
  return { manual: `Hermes memory provider "${provider}" does not have a known OpenClaw mapping.` };
}

async function buildHermesPlan(options: MigrationPlanOptions): Promise<MigrationPlan> {
  const env = options.env ?? process.env;
  const sourceDir = normalizeMigrationPath(
    options.sourceDir ?? hermesMigrationProvider.candidateSourceDirs(env)[0] ?? "~/.hermes",
  );
  const snapshot = await inspectHermesSource(sourceDir);
  const targetStateDir = normalizeMigrationPath(options.targetStateDir ?? resolveStateDir(env));
  const targetWorkspaceDir = normalizeMigrationPath(
    options.targetWorkspaceDir ?? path.join(targetStateDir, "workspace"),
  );
  const migrateSecrets = options.migrateSecrets === true;
  const createdAt = new Date().toISOString();
  const reportId = timestampForPath(new Date(createdAt));
  const actions: MigrationAction[] = [];

  addAction(actions, {
    kind: "mergeConfig",
    category: "workspace",
    path: ["agents", "defaults", "workspace"],
    value: targetWorkspaceDir,
    reason: "Set the default OpenClaw workspace for the imported Hermes agent.",
  });

  const fileMappings: Array<[string, string, "identity" | "memory"]> = [
    ["SOUL.md", "SOUL.md", "identity"],
    ["memories/USER.md", "USER.md", "memory"],
    ["memories/MEMORY.md", "MEMORY.md", "memory"],
  ];
  for (const [sourceRelative, targetRelative, category] of fileMappings) {
    const source = snapshot.files[sourceRelative];
    if (!source) {
      continue;
    }
    addAction(actions, {
      kind: "copyFile",
      category,
      source,
      target: path.join(targetWorkspaceDir, targetRelative),
      conflict: "fail",
      reason: `Import Hermes ${sourceRelative} into the OpenClaw workspace.`,
    });
  }

  const skillsDir = snapshot.directories.skills;
  if (skillsDir) {
    addAction(actions, {
      kind: "copyTree",
      category: "skills",
      source: skillsDir,
      target: path.join(targetWorkspaceDir, "skills", "hermes-imports"),
      conflict: "fail",
      reason: "Import Hermes skills into a namespaced OpenClaw workspace skill root.",
    });
  }

  addAction(actions, {
    kind: "mergeConfig",
    category: "memory",
    path: ["memory"],
    value: { backend: "builtin" },
    reason: "Use OpenClaw built-in file memory for imported Hermes memory files.",
  });
  addAction(actions, {
    kind: "mergeConfig",
    category: "plugins",
    path: ["plugins", "slots"],
    value: { memory: "memory-core" },
    reason: "Select the default OpenClaw memory plugin for imported file memory.",
  });

  const memoryProvider = mapMemoryProvider(snapshot);
  if (memoryProvider.pluginId) {
    addAction(actions, {
      kind: "enablePlugin",
      category: "plugins",
      pluginId: memoryProvider.pluginId,
      config: memoryProvider.config,
      reason: "Map the Hermes external memory provider to an OpenClaw memory plugin.",
    });
    addAction(actions, {
      kind: "manual",
      category: "memory",
      source: "config.yaml:memory.provider",
      reason:
        "Hermes used an external memory provider. OpenClaw keeps built-in memory active until the matching plugin is installed.",
      recommendation: `Install or enable the ${memoryProvider.pluginId} memory plugin, then select it for plugins.slots.memory.`,
    });
  }
  if (memoryProvider.manual) {
    addAction(actions, {
      kind: "manual",
      category: "memory",
      source: "config.yaml:memory.provider",
      reason: memoryProvider.manual,
      recommendation: "Install or configure an equivalent OpenClaw memory plugin manually.",
    });
  }

  const modelRef = inferModelRef(snapshot.config ?? {});
  if (modelRef) {
    addAction(actions, {
      kind: "mergeConfig",
      category: "models",
      path: ["agents", "defaults"],
      value: { model: modelRef },
      reason: "Import Hermes default model selection.",
    });
  }

  const providers = collectHermesProviders(snapshot);
  if (providers.length > 0) {
    const mappedProviders = Object.fromEntries(
      providers.map((entry) => [entry.id, providerConfig(entry)]),
    );
    addAction(actions, {
      kind: "mergeConfig",
      category: "models",
      path: ["models", "providers"],
      value: mappedProviders,
      reason: "Import Hermes provider and custom endpoint config.",
    });
  }

  if (migrateSecrets && snapshot.env) {
    for (const key of COMMON_SECRET_ENV_KEYS) {
      const value = snapshot.env[key];
      if (!value) {
        continue;
      }
      addAction(actions, {
        kind: "writeEnv",
        category: "secrets",
        key,
        value,
        sourceLabel: `${ENV_FILENAME}:${key}`,
        reason: `Import Hermes ${key} into OpenClaw .env.`,
      });
    }
  } else if (snapshot.env && Object.keys(snapshot.env).length > 0) {
    addAction(actions, {
      kind: "manual",
      category: "secrets",
      source: path.join(sourceDir, ENV_FILENAME),
      reason: "Hermes .env exists, but secret migration was not enabled.",
      recommendation: "Re-run with --migrate-secrets or configure equivalent OpenClaw SecretRefs.",
    });
  }

  for (const provider of providers) {
    if (!provider.apiKeyEnv) {
      continue;
    }
    addAction(actions, {
      kind: "writeSecretRef",
      category: "secrets",
      targetPath: ["models", "providers", provider.id, "apiKey"],
      envKey: provider.apiKeyEnv,
      reason: `Use ${provider.apiKeyEnv} as the SecretRef for ${provider.id}.`,
    });
  }

  const mcpServers = mapMcpServers(snapshot.config?.mcp_servers ?? snapshot.config?.mcp);
  if (mcpServers) {
    addAction(actions, {
      kind: "mergeConfig",
      category: "mcp",
      path: ["mcp", "servers"],
      value: mcpServers,
      reason: "Import Hermes MCP server definitions.",
    });
  }

  const skillEntries = mapSkillConfig(snapshot);
  if (skillEntries) {
    addAction(actions, {
      kind: "mergeConfig",
      category: "skills",
      path: ["skills", "entries"],
      value: skillEntries,
      reason: "Import Hermes skill config values.",
    });
  }

  for (const relativePath of ["plugins", "sessions", "logs", "cron", "mcp-tokens"] as const) {
    const source = snapshot.directories[relativePath];
    if (!source) {
      continue;
    }
    addAction(actions, {
      kind: "archiveOnly",
      category: relativePath === "cron" ? "automation" : "archive",
      source,
      archivePath: path.join("archive", safeRelativeArchivePath(sourceDir, source)),
      reason: `Archive Hermes ${relativePath}/ for manual review; it is not safely auto-loadable in OpenClaw v1.`,
    });
  }
  for (const relativePath of ["auth.json", "state.db"] as const) {
    const source = snapshot.files[relativePath];
    if (!source) {
      continue;
    }
    addAction(actions, {
      kind: "archiveOnly",
      category: "archive",
      source,
      archivePath: path.join("archive", safeRelativeArchivePath(sourceDir, source)),
      reason: `Archive Hermes ${relativePath}; OAuth/session-like state is not migrated automatically.`,
    });
  }

  return {
    id: `hermes-${reportId}`,
    providerId: HERMES_PROVIDER_ID,
    label: HERMES_LABEL,
    sourceDir,
    targetStateDir,
    targetWorkspaceDir,
    createdAt,
    migrateSecrets,
    actions,
    warnings: snapshot.warnings,
  };
}

export const hermesMigrationProvider: MigrationProvider = {
  id: HERMES_PROVIDER_ID,
  label: HERMES_LABEL,
  candidateSourceDirs(env = process.env) {
    return sourceDirFromEnv(env);
  },
  async detect(env = process.env) {
    const baseCandidates = sourceDirFromEnv(env);
    const profileCandidates = (
      await Promise.all(baseCandidates.map((candidate) => detectHermesProfiles(candidate)))
    ).flat();
    const detections = await Promise.all(
      [...new Set([...baseCandidates, ...profileCandidates])].map((candidate) =>
        detectHermesSourceDir(candidate),
      ),
    );
    return detections.filter((entry): entry is MigrationDetection => entry !== null);
  },
  inspect: inspectHermesSource,
  plan: buildHermesPlan,
};
