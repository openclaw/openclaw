import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretProviderConfig, SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { runSecretsApply, type SecretsApplyResult } from "./apply.js";
import { createSecretsConfigIO } from "./config-io.js";
import {
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
  type ConfigureCandidate,
} from "./configure-plan.js";
import { getSkippedExecRefStaticError } from "./exec-resolution-policy.js";
import type { SecretsApplyPlan } from "./plan.js";
import { getProviderEnvVars } from "./provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidSecretProviderAlias,
  resolveDefaultSecretProviderAlias,
} from "./ref-contract.js";
import { resolveSecretRefValue } from "./resolve.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";

export type SecretsConfigureResult = {
  plan: SecretsApplyPlan;
  preflight: SecretsApplyResult;
};

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePathValue(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalPositiveInt(value: string, max: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    return undefined;
  }
  return parsed;
}

function getSecretProviders(config: OpenClawConfig): Record<string, SecretProviderConfig> {
  if (!isRecord(config.secrets?.providers)) {
    return {};
  }
  return config.secrets.providers;
}

function setSecretProvider(
  config: OpenClawConfig,
  providerAlias: string,
  providerConfig: SecretProviderConfig,
): void {
  config.secrets ??= {};
  if (!isRecord(config.secrets.providers)) {
    config.secrets.providers = {};
  }
  config.secrets.providers[providerAlias] = providerConfig;
}

function removeSecretProvider(config: OpenClawConfig, providerAlias: string): boolean {
  if (!isRecord(config.secrets?.providers)) {
    return false;
  }
  const providers = config.secrets.providers;
  if (!Object.prototype.hasOwnProperty.call(providers, providerAlias)) {
    return false;
  }
  delete providers[providerAlias];
  if (Object.keys(providers).length === 0) {
    delete config.secrets?.providers;
  }

  if (isRecord(config.secrets?.defaults)) {
    const defaults = config.secrets.defaults;
    if (defaults?.env === providerAlias) {
      delete defaults.env;
    }
    if (defaults?.file === providerAlias) {
      delete defaults.file;
    }
    if (defaults?.exec === providerAlias) {
      delete defaults.exec;
    }
    if (
      defaults &&
      defaults.env === undefined &&
      defaults.file === undefined &&
      defaults.exec === undefined
    ) {
      delete config.secrets?.defaults;
    }
  }
  return true;
}

function providerHint(provider: SecretProviderConfig): string {
  if (provider.source === "env") {
    return provider.allowlist?.length ? `env (${provider.allowlist.length} allowlisted)` : "env";
  }
  if (provider.source === "file") {
    return `file (${provider.mode ?? "json"})`;
  }
  return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}

function toSourceChoices(config: OpenClawConfig): Array<{ value: SecretRefSource; label: string }> {
  const hasSource = (source: SecretRefSource) =>
    Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
  const choices: Array<{ value: SecretRefSource; label: string }> = [
    {
      value: "env",
      label: "Environment variable",
    },
  ];
  if (hasSource("file")) {
    choices.push({ value: "file", label: "File on disk" });
  }
  if (hasSource("exec")) {
    choices.push({ value: "exec", label: "Password manager (1Password, Bitwarden, etc.)" });
  }
  return choices;
}

function assertNoCancel<T>(value: T | symbol, message: string): T {
  if (typeof value === "symbol") {
    throw new Error(message);
  }
  return value;
}

const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function validateEnvNameCsv(value: string): string | undefined {
  const entries = parseCsv(value);
  for (const entry of entries) {
    if (!ENV_NAME_PATTERN.test(entry)) {
      return `Invalid env name: ${entry}`;
    }
  }
  return undefined;
}

async function promptEnvNameCsv(params: {
  message: string;
  initialValue: string;
}): Promise<string[]> {
  const raw = assertNoCancel(
    await text({
      message: params.message,
      initialValue: params.initialValue,
      validate: (value) => validateEnvNameCsv(value ?? ""),
    }),
    "Setup cancelled.",
  );
  return parseCsv(raw ?? "");
}

async function promptOptionalPositiveInt(params: {
  message: string;
  initialValue?: number;
  max: number;
}): Promise<number | undefined> {
  const raw = assertNoCancel(
    await text({
      message: params.message,
      initialValue: params.initialValue === undefined ? "" : String(params.initialValue),
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return undefined;
        }
        const parsed = parseOptionalPositiveInt(trimmed, params.max);
        if (parsed === undefined) {
          return `Must be an integer between 1 and ${params.max}`;
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );
  const parsed = parseOptionalPositiveInt(
    normalizeStringifiedOptionalString(raw) ?? "",
    params.max,
  );
  return parsed;
}

function configureCandidateKey(candidate: {
  configFile: "openclaw.json" | "auth-profiles.json";
  path: string;
  agentId?: string;
}): string {
  if (candidate.configFile === "auth-profiles.json") {
    return `auth-profiles:${normalizeOptionalString(candidate.agentId) ?? ""}:${candidate.path}`;
  }
  return `openclaw:${candidate.path}`;
}

function hasSourceChoice(
  sourceChoices: Array<{ value: SecretRefSource; label: string }>,
  source: SecretRefSource,
): boolean {
  return sourceChoices.some((entry) => entry.value === source);
}

function resolveCandidateProviderHint(candidate: ConfigureCandidate): string | undefined {
  return (
    normalizeOptionalLowercaseString(candidate.authProfileProvider) ??
    normalizeOptionalLowercaseString(candidate.providerId)
  );
}

function resolveSuggestedEnvSecretId(candidate: ConfigureCandidate): string | undefined {
  const hintedProvider = resolveCandidateProviderHint(candidate);
  if (!hintedProvider) {
    return undefined;
  }
  const envCandidates = getProviderEnvVars(hintedProvider);
  if (!Array.isArray(envCandidates) || envCandidates.length === 0) {
    return undefined;
  }
  return envCandidates[0];
}

function resolveConfigureAgentId(config: OpenClawConfig, explicitAgentId?: string): string {
  const knownAgentIds = new Set(listAgentIds(config));
  if (!explicitAgentId) {
    return resolveDefaultAgentId(config);
  }
  const normalized = normalizeAgentId(explicitAgentId);
  if (knownAgentIds.has(normalized)) {
    return normalized;
  }
  const known = [...knownAgentIds].toSorted().join(", ");
  throw new Error(
    `Unknown agent id "${explicitAgentId}". Known agents: ${known || "none configured"}.`,
  );
}

function loadAuthProfileStoreForConfigure(params: {
  config: OpenClawConfig;
  agentId: string;
}): AuthProfileStore {
  const agentDir = resolveAgentDir(params.config, params.agentId);
  return (
    loadPersistedAuthProfileStore(agentDir) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    }
  );
}

async function promptNewAuthProfileCandidate(agentId: string): Promise<ConfigureCandidate> {
  const profileId = assertNoCancel(
    await text({
      message: "Auth profile id",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!AUTH_PROFILE_ID_PATTERN.test(trimmed)) {
          return 'Use letters/numbers/":"/"_"/"-" only.';
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );

  const credentialType = assertNoCancel(
    await select({
      message: "Auth profile credential type",
      options: [
        { value: "api_key", label: "api_key (key/keyRef)" },
        { value: "token", label: "token (token/tokenRef)" },
      ],
    }),
    "Setup cancelled.",
  );

  const provider = assertNoCancel(
    await text({
      message: "Provider id",
      validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    }),
    "Setup cancelled.",
  );

  const profileIdTrimmed = normalizeStringifiedOptionalString(profileId) ?? "";
  const providerTrimmed = normalizeStringifiedOptionalString(provider) ?? "";
  if (credentialType === "token") {
    return {
      type: "auth-profiles.token.token",
      path: `profiles.${profileIdTrimmed}.token`,
      pathSegments: ["profiles", profileIdTrimmed, "token"],
      label: `profiles.${profileIdTrimmed}.token (auth profile, agent ${agentId})`,
      configFile: "auth-profiles.json",
      agentId,
      authProfileProvider: providerTrimmed,
      expectedResolvedValue: "string",
    };
  }
  return {
    type: "auth-profiles.api_key.key",
    path: `profiles.${profileIdTrimmed}.key`,
    pathSegments: ["profiles", profileIdTrimmed, "key"],
    label: `profiles.${profileIdTrimmed}.key (auth profile, agent ${agentId})`,
    configFile: "auth-profiles.json",
    agentId,
    authProfileProvider: providerTrimmed,
    expectedResolvedValue: "string",
  };
}

async function promptProviderAlias(params: { existingAliases: Set<string> }): Promise<string> {
  const alias = assertNoCancel(
    await text({
      message: "Name this source (e.g. '1password', 'bitwarden', 'env')",
      initialValue: "default",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isValidSecretProviderAlias(trimmed)) {
          return "Use lowercase letters, numbers, hyphens, or underscores";
        }
        if (params.existingAliases.has(trimmed)) {
          return "You already have a source with this name";
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );
  return normalizeStringifiedOptionalString(alias) ?? "";
}

async function promptProviderSource(initial?: SecretRefSource): Promise<SecretRefSource> {
  const source = assertNoCancel(
    await select({
      message: "What kind of source?",
      options: [
        { value: "env", label: "Environment variables" },
        { value: "file", label: "File on disk" },
        { value: "exec", label: "Password manager (1Password, Bitwarden, etc.)" },
      ],
      initialValue: initial,
    }),
    "Setup cancelled.",
  );
  return source as SecretRefSource;
}

async function promptEnvProvider(
  base?: Extract<SecretProviderConfig, { source: "env" }>,
): Promise<Extract<SecretProviderConfig, { source: "env" }>> {
  const allowlist = await promptEnvNameCsv({
    message: "Which env vars to allow? (comma-separated, leave blank for all)",
    initialValue: base?.allowlist?.join(",") ?? "",
  });
  return {
    source: "env",
    ...(allowlist.length > 0 ? { allowlist } : {}),
  };
}

async function promptFileProvider(
  base?: Extract<SecretProviderConfig, { source: "file" }>,
): Promise<Extract<SecretProviderConfig, { source: "file" }>> {
  const filePath = assertNoCancel(
    await text({
      message: "Path to the file (absolute path)",
      initialValue: base?.path ?? "",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path starting with /";
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );

  const mode = assertNoCancel(
    await select({
      message: "How is the file formatted?",
      options: [
        { value: "json", label: "JSON (key-value pairs)" },
        { value: "singleValue", label: "Single value (just the secret)" },
      ],
      initialValue: base?.mode ?? "json",
    }),
    "Setup cancelled.",
  );

  const timeoutMs = await promptOptionalPositiveInt({
    message: "Read timeout in ms (blank for default)",
    initialValue: base?.timeoutMs,
    max: 120000,
  });
  const maxBytes = await promptOptionalPositiveInt({
    message: "Max file size in bytes (blank for default)",
    initialValue: base?.maxBytes,
    max: 20 * 1024 * 1024,
  });
  const allowInsecurePath = assertNoCancel(
    await confirm({
      message: "Skip strict path security checks?",
      initialValue: base?.allowInsecurePath ?? false,
    }),
    "Setup cancelled.",
  );

  return {
    source: "file",
    path: normalizeStringifiedOptionalString(filePath) ?? "",
    mode,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxBytes ? { maxBytes } : {}),
    ...(allowInsecurePath ? { allowInsecurePath: true } : {}),
  };
}

async function parseArgsInput(rawValue: string): Promise<string[] | undefined> {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("args must be a JSON array of strings");
  }
  return parsed;
}

async function promptExecProvider(
  base?: Extract<SecretProviderConfig, { source: "exec" }>,
): Promise<Extract<SecretProviderConfig, { source: "exec" }>> {
  const command = assertNoCancel(
    await text({
      message: "Path to the CLI tool (absolute)",
      initialValue: base?.command ?? "",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path starting with /";
        }
        if (!isSafeExecutableValue(trimmed)) {
          return "This command is not allowed for security";
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );

  const argsRaw = assertNoCancel(
    await text({
      message: 'Command arguments (JSON array like ["get", "password"], blank for none)',
      initialValue: JSON.stringify(base?.args ?? []),
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            return 'Must be a JSON array of strings, e.g. ["get", "password"]';
          }
          return undefined;
        } catch {
          return "Must be valid JSON";
        }
      },
    }),
    "Setup cancelled.",
  );

  const timeoutMs = await promptOptionalPositiveInt({
    message: "Command timeout in ms (blank for default)",
    initialValue: base?.timeoutMs,
    max: 120000,
  });

  const noOutputTimeoutMs = await promptOptionalPositiveInt({
    message: "Timeout if no output in ms (blank for default)",
    initialValue: base?.noOutputTimeoutMs,
    max: 120000,
  });

  const maxOutputBytes = await promptOptionalPositiveInt({
    message: "Max output size in bytes (blank for default)",
    initialValue: base?.maxOutputBytes,
    max: 20 * 1024 * 1024,
  });

  const jsonOnly = assertNoCancel(
    await confirm({
      message: "Expect JSON output from the command?",
      initialValue: base?.jsonOnly ?? true,
    }),
    "Setup cancelled.",
  );

  const passEnv = await promptEnvNameCsv({
    message: "Env vars to pass through to the command (comma-separated, blank for none)",
    initialValue: base?.passEnv?.join(",") ?? "",
  });

  const trustedDirsRaw = assertNoCancel(
    await text({
      message: "Trusted directories (comma-separated absolute paths, blank for none)",
      initialValue: base?.trustedDirs?.join(",") ?? "",
      validate: (value) => {
        const entries = parseCsv(value ?? "");
        for (const entry of entries) {
          if (!isAbsolutePathValue(entry)) {
            return `Trusted dir must be absolute: ${entry}`;
          }
        }
        return undefined;
      },
    }),
    "Setup cancelled.",
  );

  const allowInsecurePath = assertNoCancel(
    await confirm({
      message: "Allow insecure command path checks?",
      initialValue: base?.allowInsecurePath ?? false,
    }),
    "Setup cancelled.",
  );
  const allowSymlinkCommand = assertNoCancel(
    await confirm({
      message: "Allow symlink command path?",
      initialValue: base?.allowSymlinkCommand ?? false,
    }),
    "Setup cancelled.",
  );

  const args = await parseArgsInput(normalizeStringifiedOptionalString(argsRaw) ?? "");
  const trustedDirs = parseCsv(trustedDirsRaw ?? "");

  return {
    source: "exec",
    command: normalizeStringifiedOptionalString(command) ?? "",
    ...(args && args.length > 0 ? { args } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(noOutputTimeoutMs ? { noOutputTimeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    ...(jsonOnly ? { jsonOnly } : { jsonOnly: false }),
    ...(passEnv.length > 0 ? { passEnv } : {}),
    ...(trustedDirs.length > 0 ? { trustedDirs } : {}),
    ...(allowInsecurePath ? { allowInsecurePath: true } : {}),
    ...(allowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
    ...(isRecord(base?.env) ? { env: base.env } : {}),
  };
}

async function promptProviderConfig(
  source: SecretRefSource,
  current?: SecretProviderConfig,
): Promise<SecretProviderConfig> {
  if (source === "env") {
    return await promptEnvProvider(current?.source === "env" ? current : undefined);
  }
  if (source === "file") {
    return await promptFileProvider(current?.source === "file" ? current : undefined);
  }
  return await promptExecProvider(current?.source === "exec" ? current : undefined);
}

async function configureProvidersInteractive(config: OpenClawConfig): Promise<void> {
  while (true) {
    const providers = getSecretProviders(config);
    const providerEntries = Object.entries(providers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );

    const actionOptions: Array<{ value: string; label: string; hint?: string }> = [
      {
        value: "add",
        label: "Add source",
        hint: "Connect 1Password, Bitwarden, or env/file sources",
      },
    ];
    if (providerEntries.length > 0) {
      actionOptions.push({
        value: "edit",
        label: "Edit source",
        hint: "Update an existing source",
      });
      actionOptions.push({
        value: "remove",
        label: "Remove source",
        hint: "Disconnect a source",
      });
    }
    actionOptions.push({
      value: "continue",
      label: "Continue",
      hint: "Link your credentials",
    });

    const action = assertNoCancel(
      await select({
        message:
          providerEntries.length > 0
            ? "Choose how to handle your saved passwords and keys"
            : "Choose how to handle your saved passwords and keys (env vars work out of the box — add a password manager for more options)",
        options: actionOptions,
      }),
      "Setup cancelled.",
    );

    if (action === "continue") {
      return;
    }

    if (action === "add") {
      const source = await promptProviderSource();
      const alias = await promptProviderAlias({
        existingAliases: new Set(providerEntries.map(([providerAlias]) => providerAlias)),
      });
      const providerConfig = await promptProviderConfig(source);
      setSecretProvider(config, alias, providerConfig);
      continue;
    }

    if (action === "edit") {
      const alias = assertNoCancel(
        await select({
          message: "Which source to update?",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            value: providerAlias,
            label: providerAlias,
            hint: providerHint(providerConfig),
          })),
        }),
        "Setup cancelled.",
      );
      const current = providers[alias];
      if (!current) {
        continue;
      }
      const source = await promptProviderSource(current.source);
      const nextProviderConfig = await promptProviderConfig(source, current);
      if (!isDeepStrictEqual(current, nextProviderConfig)) {
        setSecretProvider(config, alias, nextProviderConfig);
      }
      continue;
    }

    if (action === "remove") {
      const alias = assertNoCancel(
        await select({
          message: "Which source to disconnect?",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            value: providerAlias,
            label: providerAlias,
            hint: providerHint(providerConfig),
          })),
        }),
        "Setup cancelled.",
      );

      const shouldRemove = assertNoCancel(
        await confirm({
          message: `Disconnect "${alias}"?`,
          initialValue: false,
        }),
        "Setup cancelled.",
      );
      if (shouldRemove) {
        removeSecretProvider(config, alias);
      }
    }
  }
}

export async function runSecretsConfigureInteractive(
  params: {
    env?: NodeJS.ProcessEnv;
    providersOnly?: boolean;
    skipProviderSetup?: boolean;
    agentId?: string;
    allowExecInPreflight?: boolean;
  } = {},
): Promise<SecretsConfigureResult> {
  if (!process.stdin.isTTY) {
    throw new Error("This setup needs an interactive terminal. Run it in a shell, not a script.");
  }
  if (params.providersOnly && params.skipProviderSetup) {
    throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
  }

  const env = params.env ?? process.env;
  const allowExecInPreflight = Boolean(params.allowExecInPreflight);
  const io = createSecretsConfigIO({ env });
  const { snapshot } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Can't start setup — your config file has errors. Fix them first.");
  }

  const stagedConfig = structuredClone(snapshot.config);
  if (!params.skipProviderSetup) {
    await configureProvidersInteractive(stagedConfig);
  }

  const providerChanges = collectConfigureProviderChanges({
    original: snapshot.config,
    next: stagedConfig,
  });

  const selectedByPath = new Map<string, ConfigureCandidate & { ref: SecretRef }>();
  if (!params.providersOnly) {
    const configureAgentId = resolveConfigureAgentId(snapshot.config, params.agentId);
    const authStore = loadAuthProfileStoreForConfigure({
      config: snapshot.config,
      agentId: configureAgentId,
    });
    const candidates = buildConfigureCandidatesForScope({
      config: stagedConfig,
      authoredOpenClawConfig: snapshot.resolved,
      authProfiles: {
        agentId: configureAgentId,
        store: authStore,
      },
    });
    if (candidates.length === 0) {
      throw new Error("No credentials need linking for this agent. You're all set!");
    }

    const sourceChoices = toSourceChoices(stagedConfig);
    const hasDerivedCandidates = candidates.some((candidate) => candidate.isDerived === true);
    let showDerivedCandidates = false;

    while (true) {
      const visibleCandidates = showDerivedCandidates
        ? candidates
        : candidates.filter((candidate) => candidate.isDerived !== true);
      const options = visibleCandidates.map((candidate) => ({
        value: configureCandidateKey(candidate),
        label: candidate.label,
        hint: candidate.configFile === "auth-profiles.json" ? "per-agent" : "global",
      }));
      options.push({
        value: "__create_auth_profile__",
        label: "Add new credential",
        hint: `For agent ${configureAgentId}`,
      });
      if (hasDerivedCandidates) {
        options.push({
          value: "__toggle_derived__",
          label: showDerivedCandidates ? "Hide auto-detected" : "Show auto-detected",
          hint: showDerivedCandidates
            ? "Show only manually configured"
            : "Include detected from config",
        });
      }
      if (selectedByPath.size > 0) {
        options.unshift({
          value: "__done__",
          label: "Done",
          hint: "Save and verify",
        });
      }

      const selectedPath = assertNoCancel(
        await select({
          message: "Which credential do you want to link?",
          options,
        }),
        "Setup cancelled.",
      );

      if (selectedPath === "__done__") {
        break;
      }
      if (selectedPath === "__create_auth_profile__") {
        const createdCandidate = await promptNewAuthProfileCandidate(configureAgentId);
        const key = configureCandidateKey(createdCandidate);
        const existingIndex = candidates.findIndex((entry) => configureCandidateKey(entry) === key);
        if (existingIndex >= 0) {
          candidates[existingIndex] = createdCandidate;
        } else {
          candidates.push(createdCandidate);
        }
        continue;
      }
      if (selectedPath === "__toggle_derived__") {
        showDerivedCandidates = !showDerivedCandidates;
        continue;
      }

      const candidate = visibleCandidates.find(
        (entry) => configureCandidateKey(entry) === selectedPath,
      );
      if (!candidate) {
        throw new Error(`Unknown configure target: ${selectedPath}`);
      }
      const candidateKey = configureCandidateKey(candidate);
      const priorSelection = selectedByPath.get(candidateKey);
      const existingRef = priorSelection?.ref ?? candidate.existingRef;
      const sourceInitialValue =
        existingRef && hasSourceChoice(sourceChoices, existingRef.source)
          ? existingRef.source
          : undefined;

      const source = assertNoCancel(
        await select({
          message: "Where is this credential stored?",
          options: sourceChoices,
          initialValue: sourceInitialValue,
        }),
        "Setup cancelled.",
      ) as SecretRefSource;

      const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, {
        preferFirstProviderForSource: true,
      });
      const providerInitialValue =
        existingRef?.source === source ? existingRef.provider : defaultAlias;
      const provider = assertNoCancel(
        await text({
          message: "Which source? (name you gave it above)",
          initialValue: providerInitialValue,
          validate: (value) => {
            const trimmed = normalizeStringifiedOptionalString(value) ?? "";
            if (!trimmed) {
              return "Required";
            }
            if (!isValidSecretProviderAlias(trimmed)) {
              return "Use lowercase letters, numbers, hyphens, or underscores";
            }
            return undefined;
          },
        }),
        "Setup cancelled.",
      );
      const providerAlias = normalizeStringifiedOptionalString(provider) ?? "";
      const suggestedIdFromExistingRef =
        existingRef?.source === source ? existingRef.id : undefined;
      let suggestedId = suggestedIdFromExistingRef;
      if (!suggestedId && source === "env") {
        suggestedId = resolveSuggestedEnvSecretId(candidate);
      }
      if (!suggestedId && source === "file") {
        const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
        if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") {
          suggestedId = "value";
        }
      }
      const id = assertNoCancel(
        await text({
          message: "What's the credential called in that source?",
          initialValue: suggestedId,
          validate: (value) => {
            const trimmed = normalizeStringifiedOptionalString(value) ?? "";
            if (!trimmed) {
              return "Required";
            }
            if (source === "exec" && !isValidExecSecretRefId(trimmed)) {
              return formatExecSecretRefIdValidationMessage();
            }
            return undefined;
          },
        }),
        "Setup cancelled.",
      );
      const ref: SecretRef = {
        source,
        provider: providerAlias,
        id: normalizeStringifiedOptionalString(id) ?? "",
      };
      if (ref.source === "exec" && !allowExecInPreflight) {
        const staticError = getSkippedExecRefStaticError({
          ref,
          config: stagedConfig,
        });
        if (staticError) {
          throw new Error(staticError);
        }
      } else {
        const resolved = await resolveSecretRefValue(ref, {
          config: stagedConfig,
          env,
        });
        assertExpectedResolvedSecretValue({
          value: resolved,
          expected: candidate.expectedResolvedValue,
          errorMessage:
            candidate.expectedResolvedValue === "string"
              ? `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a non-empty string.`
              : `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a supported value type.`,
        });
      }

      const next = {
        ...candidate,
        ref,
      };
      selectedByPath.set(candidateKey, next);

      const addMore = assertNoCancel(
        await confirm({
          message: "Configure another credential?",
          initialValue: true,
        }),
        "Setup cancelled.",
      );
      if (!addMore) {
        break;
      }
    }
  }

  if (!hasConfigurePlanChanges({ selectedTargets: selectedByPath, providerChanges })) {
    throw new Error("No secrets changes were selected.");
  }

  const plan = buildSecretsConfigurePlan({
    selectedTargets: selectedByPath,
    providerChanges,
  });

  const preflight = await runSecretsApply({
    plan,
    env,
    write: false,
    allowExec: allowExecInPreflight,
  });

  return { plan, preflight };
}
