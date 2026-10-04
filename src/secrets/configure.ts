/** Interactive and noninteractive secrets configure workflow. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log, confirm, select, text, type CANCEL_SYMBOL } from "@clack/prompts";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  isValidEnvSecretRefId,
  type ManualExecSecretProviderConfig,
  type SecretProviderConfig,
  type SecretRef,
  type SecretRefSource,
} from "../config/types.secrets.js";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { runSecretsApply, type SecretsApplyResult } from "./apply.js";
import { iterateAuthProfileCredentials } from "./auth-profiles-scan.js";
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
import { getProviderEnvVarsCore } from "./provider-env-vars.js";
import { listSecretProviderIntegrationPresets } from "./provider-integrations.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidSecretProviderAlias,
  resolveDefaultSecretProviderAlias,
} from "./ref-contract.js";
import { resolveSecretRefValue } from "./resolve.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isNonEmptyString, isRecord } from "./shared.js";

/** Result returned after interactive secrets configure builds and preflights an apply plan. */
type SecretsConfigureResult = {
  plan: SecretsApplyPlan;
  preflight: SecretsApplyResult;
};

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePathValue(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function parseOptionalPositiveInt(value: string, max: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(trimmed);
  if (parsed === undefined || parsed > max) {
    return undefined;
  }
  return parsed;
}

function setSecretProvider(
  config: OpenClawConfig,
  providerAlias: string,
  providerConfig: SecretProviderConfig,
): void {
  config.secrets ??= {};
  config.secrets.providers ??= {};
  config.secrets.providers[providerAlias] = providerConfig;
}

function removeSecretProvider(config: OpenClawConfig, providerAlias: string): boolean {
  if (!config.secrets?.providers) {
    return false;
  }
  const providers = config.secrets.providers;
  if (!Object.hasOwn(providers, providerAlias)) {
    return false;
  }
  delete providers[providerAlias];
  if (Object.keys(providers).length === 0) {
    delete config.secrets.providers;
  }

  if (config.secrets.defaults) {
    const defaults = config.secrets.defaults;
    const sources = ["env", "file", "exec", "store"] as const;
    for (const source of sources) {
      if (defaults[source] === providerAlias) {
        delete defaults[source];
      }
    }
    if (sources.every((source) => defaults[source] === undefined)) {
      delete config.secrets.defaults;
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
  if (provider.source === "store") {
    return "store";
  }
  if ("pluginIntegration" in provider) {
    const { pluginId, integrationId } = provider.pluginIntegration;
    return `exec plugin (${pluginId}:${integrationId})`;
  }
  return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}

function toSourceChoices(config: OpenClawConfig): Array<{ value: SecretRefSource; label: string }> {
  const hasSource = (source: SecretRefSource) =>
    Object.values(config.secrets?.providers ?? {}).some((provider) => provider.source === source);
  const choices: Array<{ value: SecretRefSource; label: string }> = [
    {
      value: "env",
      label: "env",
    },
    { value: "store", label: "store" },
  ];
  if (hasSource("file")) {
    choices.push({ value: "file", label: "file" });
  }
  if (hasSource("exec")) {
    choices.push({ value: "exec", label: "exec" });
  }
  return choices;
}

function assertNoCancel<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (typeof value === "symbol") {
    throw new Error("Secrets configure cancelled.");
  }
  return value;
}

async function promptRequiredText(params: {
  message: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const value = assertNoCancel(
    await text({
      ...params,
      validate: (value) => {
        const trimmed = value?.trim() ?? "";
        return trimmed ? params.validate?.(trimmed) : "Required";
      },
    }),
  );
  return value.trim();
}

const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function validateEnvNameCsv(value: string): string | undefined {
  const entries = normalizeCsvOrLooseStringList(value);
  for (const entry of entries) {
    if (!isValidEnvSecretRefId(entry)) {
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
  );
  return normalizeCsvOrLooseStringList(raw);
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
  );
  return parseOptionalPositiveInt(raw, params.max);
}

function configureCandidateKey(candidate: {
  configFile: "openclaw.json" | "auth-profile-store";
  path: string;
  agentId?: string;
}): string {
  if (candidate.configFile === "auth-profile-store") {
    return `auth-profiles:${normalizeOptionalString(candidate.agentId) ?? ""}:${candidate.path}`;
  }
  return `openclaw:${candidate.path}`;
}

function resolveSuggestedEnvSecretId(candidate: ConfigureCandidate): string | undefined {
  const hintedProvider =
    normalizeOptionalLowercaseString(candidate.authProfileProvider) ??
    normalizeOptionalLowercaseString(candidate.providerId);
  if (!hintedProvider) {
    return undefined;
  }
  return getProviderEnvVarsCore(hintedProvider)[0];
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

/**
 * Counts plaintext (non-SecretRef) credentials in the canonical shared
 * auth-profile store. `secrets configure` only edits the selected agent's
 * local store; shared profiles are not writable here. Surfacing the count
 * lets an operator know a shared plaintext migration is pending so they do
 * not mistake "no shared candidate" for "shared store is clean".
 *
 * Classification mirrors `secrets audit` (audit.ts): the raw shared row is
 * read without normalization so a stored `key` survives even when a sibling
 * `keyRef` is present (the normalized loader drops `key` in that case), and
 * an authored value that is itself a supported SecretRef shorthand
 * (`$ENV` / `${ENV}`) is treated as a reference, not plaintext.
 */
function countSharedAuthProfilePlaintext(env: NodeJS.ProcessEnv): number {
  const shared = readPersistedSharedAuthProfileStoreRaw(env);
  if (!isRecord(shared) || !isRecord(shared.profiles)) {
    return 0;
  }
  let plaintext = 0;
  for (const entry of iterateAuthProfileCredentials(shared.profiles)) {
    if (entry.kind !== "api_key" && entry.kind !== "token") {
      continue;
    }
    if (coerceSecretRef(entry.value)) {
      continue;
    }
    if (isNonEmptyString(entry.value)) {
      plaintext += 1;
    }
  }
  return plaintext;
}

async function promptNewAuthProfileCandidate(agentId: string): Promise<ConfigureCandidate> {
  const profileId = await promptRequiredText({
    message: "Auth profile id",
    validate: (value) =>
      AUTH_PROFILE_ID_PATTERN.test(value) ? undefined : 'Use letters/numbers/":"/"_"/"-" only.',
  });

  const credentialType = assertNoCancel(
    await select({
      message: "Auth profile credential type",
      options: [
        { value: "api_key", label: "api_key (key/keyRef)" },
        { value: "token", label: "token (token/tokenRef)" },
      ],
    }),
  );

  const provider = await promptRequiredText({ message: "Provider id" });

  const field = credentialType === "token" ? "token" : "key";
  return {
    type: credentialType === "token" ? "auth-profiles.token.token" : "auth-profiles.api_key.key",
    path: `profiles.${profileId}.${field}`,
    pathSegments: ["profiles", profileId, field],
    label: `profiles.${profileId}.${field} (auth profile, agent ${agentId})`,
    configFile: "auth-profile-store",
    agentId,
    authProfileProvider: provider,
    expectedResolvedValue: "string",
  };
}

async function promptProviderAlias(params: { existingAliases: Set<string> }): Promise<string> {
  return await promptRequiredText({
    message: "Provider alias",
    initialValue: "default",
    validate: (value) => {
      if (!isValidSecretProviderAlias(value)) {
        return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
      }
      return params.existingAliases.has(value) ? "Alias already exists" : undefined;
    },
  });
}

async function promptProviderSource(initial?: SecretRefSource): Promise<SecretRefSource> {
  return assertNoCancel(
    await select<SecretRefSource>({
      message: "Provider source",
      options: [
        { value: "env", label: "env" },
        { value: "file", label: "file" },
        { value: "exec", label: "exec" },
        { value: "store", label: "store" },
      ],
      initialValue: initial,
    }),
  );
}

async function promptEnvProvider(
  base?: Extract<SecretProviderConfig, { source: "env" }>,
): Promise<Extract<SecretProviderConfig, { source: "env" }>> {
  const allowlist = await promptEnvNameCsv({
    message: "Env allowlist (comma-separated, blank for unrestricted)",
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
  const filePath = await promptRequiredText({
    message: "File path (absolute)",
    initialValue: base?.path ?? "",
    validate: (value) => (isAbsolutePathValue(value) ? undefined : "Must be an absolute path"),
  });

  const mode = assertNoCancel(
    await select({
      message: "File mode",
      options: [
        { value: "json", label: "json" },
        { value: "singleValue", label: "singleValue" },
      ],
      initialValue: base?.mode ?? "json",
    }),
  );

  const timeoutMs = await promptOptionalPositiveInt({
    message: "Timeout ms (blank for default)",
    initialValue: base?.timeoutMs,
    max: 120000,
  });
  const maxBytes = await promptOptionalPositiveInt({
    message: "Max bytes (blank for default)",
    initialValue: base?.maxBytes,
    max: 20 * 1024 * 1024,
  });
  return {
    source: "file",
    path: filePath,
    mode,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxBytes ? { maxBytes } : {}),
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
  base?: ManualExecSecretProviderConfig,
): Promise<ManualExecSecretProviderConfig> {
  const command = await promptRequiredText({
    message: "Command path (absolute)",
    initialValue: base?.command ?? "",
    validate: (value) => {
      if (!isAbsolutePathValue(value)) {
        return "Must be an absolute path";
      }
      return isSafeExecutableValue(value) ? undefined : "Command value is not allowed";
    },
  });

  const argsRaw = assertNoCancel(
    await text({
      message: "Args JSON array (blank for none)",
      initialValue: JSON.stringify(base?.args ?? []),
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            return "Must be a JSON array of strings";
          }
          return undefined;
        } catch {
          return "Must be valid JSON";
        }
      },
    }),
  );

  const timeoutMs = await promptOptionalPositiveInt({
    message: "Timeout ms (blank for default)",
    initialValue: base?.timeoutMs,
    max: 120000,
  });

  const noOutputTimeoutMs = await promptOptionalPositiveInt({
    message: "No-output timeout ms (blank for default)",
    initialValue: base?.noOutputTimeoutMs,
    max: 120000,
  });

  const maxOutputBytes = await promptOptionalPositiveInt({
    message: "Max output bytes (blank for default)",
    initialValue: base?.maxOutputBytes,
    max: 20 * 1024 * 1024,
  });

  const jsonOnly = assertNoCancel(
    await confirm({
      message: "Require JSON-only response?",
      initialValue: base?.jsonOnly ?? true,
    }),
  );

  const passEnv = await promptEnvNameCsv({
    message: "Pass-through env vars (comma-separated, blank for none)",
    initialValue: base?.passEnv?.join(",") ?? "",
  });

  const trustedDirsRaw = assertNoCancel(
    await text({
      message: "Trusted dirs (comma-separated absolute paths, blank for none)",
      initialValue: base?.trustedDirs?.join(",") ?? "",
      validate: (value) => {
        const entries = normalizeCsvOrLooseStringList(value ?? "");
        for (const entry of entries) {
          if (!isAbsolutePathValue(entry)) {
            return `Trusted dir must be absolute: ${entry}`;
          }
        }
        return undefined;
      },
    }),
  );

  const args = await parseArgsInput(argsRaw);
  const trustedDirs = normalizeCsvOrLooseStringList(trustedDirsRaw);

  return {
    source: "exec",
    command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(noOutputTimeoutMs ? { noOutputTimeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    jsonOnly,
    ...(passEnv.length > 0 ? { passEnv } : {}),
    ...(trustedDirs.length > 0 ? { trustedDirs } : {}),
    ...(base?.env ? { env: base.env } : {}),
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
  if (source === "store") {
    return { source: "store" };
  }
  return await promptExecProvider(
    current?.source === "exec" && "command" in current ? current : undefined,
  );
}

async function configureProvidersInteractive(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const manifestRegistry = loadPluginManifestRegistryCore({ config, env });
  const presets = listSecretProviderIntegrationPresets({ manifestRegistry, config, env });
  while (true) {
    const providers = config.secrets?.providers ?? {};
    const providerEntries = Object.entries(providers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    const presetEntries = presets.filter((preset) => {
      const current = providers[preset.providerAlias];
      return !current || !isDeepStrictEqual(current, preset.providerConfig);
    });

    const actionOptions: Array<{ value: string; label: string; hint?: string }> = [
      {
        value: "add",
        label: "Add provider",
        hint: "Define a new env/file/exec/store provider",
      },
    ];
    if (presetEntries.length > 0) {
      actionOptions.push({
        value: "preset",
        label: "Use plugin preset",
        hint: "Configure a provider declared by an installed plugin",
      });
    }
    if (providerEntries.length > 0) {
      actionOptions.push({
        value: "edit",
        label: "Edit provider",
        hint: "Update an existing provider",
      });
      actionOptions.push({
        value: "remove",
        label: "Remove provider",
        hint: "Delete a provider alias",
      });
    }
    actionOptions.push({
      value: "continue",
      label: "Continue",
      hint: "Move to credential mapping",
    });

    const action = assertNoCancel(
      await select({
        message:
          providerEntries.length > 0
            ? "Configure secret providers"
            : "Configure secret providers (env/store refs are built in; add file/exec providers as needed)",
        options: actionOptions,
      }),
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

    if (action === "preset") {
      const preset = assertNoCancel(
        await select({
          message: "Select plugin preset",
          options: presetEntries.map((preset) => ({
            value: preset,
            label: preset.displayName,
            hint: `${preset.providerAlias} | ${preset.pluginId}:${preset.id} | exec plugin`,
          })),
        }),
      );
      const current = providers[preset.providerAlias];
      if (current) {
        const shouldReplace = assertNoCancel(
          await confirm({
            message: `Replace provider "${preset.providerAlias}" with the ${preset.displayName} preset?`,
            initialValue: false,
          }),
        );
        if (!shouldReplace) {
          continue;
        }
      }
      setSecretProvider(config, preset.providerAlias, structuredClone(preset.providerConfig));
      continue;
    }

    if (action === "edit" || action === "remove") {
      const { alias, provider: current } = assertNoCancel(
        await select({
          message: action === "edit" ? "Select provider to edit" : "Select provider to remove",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            value: { alias: providerAlias, provider: providerConfig },
            label: providerAlias,
            hint: providerHint(providerConfig),
          })),
        }),
      );
      if (action === "edit") {
        const source = await promptProviderSource(current.source);
        const nextProviderConfig = await promptProviderConfig(source, current);
        if (!isDeepStrictEqual(current, nextProviderConfig)) {
          setSecretProvider(config, alias, nextProviderConfig);
        }
        continue;
      }
      const shouldRemove = assertNoCancel(
        await confirm({
          message: `Remove provider "${alias}"?`,
          initialValue: false,
        }),
      );
      if (shouldRemove) {
        removeSecretProvider(config, alias);
      }
    }
  }
}

/** Runs interactive secrets configuration and returns changed config/auth-store state. */
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
    throw new Error("secrets configure requires an interactive TTY.");
  }
  if (params.providersOnly && params.skipProviderSetup) {
    throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
  }

  const env = params.env ?? process.env;
  const allowExecInPreflight = Boolean(params.allowExecInPreflight);
  const io = createSecretsConfigIO({ env });
  const { snapshot } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot run interactive secrets configure because config is invalid.");
  }

  const stagedConfig = structuredClone(snapshot.config);
  if (!params.skipProviderSetup) {
    await configureProvidersInteractive(stagedConfig, env);
  }

  const providerChanges = collectConfigureProviderChanges({
    original: snapshot.config,
    next: stagedConfig,
  });

  const selectedByPath = new Map<string, ConfigureCandidate & { ref: SecretRef }>();
  if (!params.providersOnly) {
    const configureAgentId = resolveConfigureAgentId(snapshot.config, params.agentId);
    const agentDir = resolveAgentDir(snapshot.config, configureAgentId);
    const authStore = loadPersistedAuthProfileStore(agentDir) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    const candidates = buildConfigureCandidatesForScope({
      config: stagedConfig,
      authoredOpenClawConfig: snapshot.resolved,
      authProfiles: {
        agentId: configureAgentId,
        store: authStore,
      },
    });
    // `secrets configure` only edits the selected agent's local auth-profile
    // store. Shared-store credentials are not writable here (routing a shared
    // SecretRef through this plan would write to the per-agent database).
    // Warn when the canonical shared store still carries plaintext so the
    // operator knows a shared migration is pending rather than already clean.
    const sharedPlaintextCount = countSharedAuthProfilePlaintext(env);
    if (sharedPlaintextCount > 0) {
      log.warn(
        `Shared auth-profile store has ${sharedPlaintextCount} plaintext credential(s). ` +
          "`secrets configure` edits the selected agent's local store only and cannot migrate shared credentials. " +
          "Run `openclaw secrets audit` to review them; a shared-store SecretRef migration path is tracked separately.",
        { output: process.stderr },
      );
    }
    if (candidates.length === 0) {
      throw new Error("No configurable secret-bearing fields found for this agent scope.");
    }

    const sourceChoices = toSourceChoices(stagedConfig);
    const hasDerivedCandidates = candidates.some((candidate) => candidate.isDerived === true);
    let showDerivedCandidates = false;

    while (true) {
      const visibleCandidates = showDerivedCandidates
        ? candidates
        : candidates.filter((candidate) => candidate.isDerived !== true);
      const options: Array<{
        value: ConfigureCandidate | "__create_auth_profile__" | "__toggle_derived__" | "__done__";
        label: string;
        hint: string;
      }> = visibleCandidates.map((candidate) => ({
        value: candidate,
        label: candidate.label,
        hint: [
          // Auth profiles live in the agent's SQLite store; naming the retired
          // JSON file here sent operators looking for a file that no longer exists.
          candidate.configFile === "auth-profile-store" ? "auth profile store" : "openclaw.json",
          candidate.isDerived === true ? "derived" : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
      }));
      options.push({
        value: "__create_auth_profile__",
        label: "Create auth profile mapping",
        hint: `Add a new auth-profiles target for agent ${configureAgentId}`,
      });
      if (hasDerivedCandidates) {
        options.push({
          value: "__toggle_derived__",
          label: showDerivedCandidates ? "Hide derived targets" : "Show derived targets",
          hint: showDerivedCandidates
            ? "Show only fields authored directly in config"
            : "Include normalized/derived aliases",
        });
      }
      if (selectedByPath.size > 0) {
        options.unshift({
          value: "__done__",
          label: "Done",
          hint: "Finish and run preflight",
        });
      }

      const candidate = assertNoCancel(
        await select({
          message: "Select credential field",
          options,
        }),
      );

      if (candidate === "__done__") {
        break;
      }
      if (candidate === "__create_auth_profile__") {
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
      if (candidate === "__toggle_derived__") {
        showDerivedCandidates = !showDerivedCandidates;
        continue;
      }

      const candidateKey = configureCandidateKey(candidate);
      const priorSelection = selectedByPath.get(candidateKey);
      const existingRef = priorSelection?.ref ?? candidate.existingRef;
      const sourceInitialValue =
        existingRef && sourceChoices.some((entry) => entry.value === existingRef.source)
          ? existingRef.source
          : undefined;

      const source = assertNoCancel(
        await select({
          message: "Secret source",
          options: sourceChoices,
          initialValue: sourceInitialValue,
        }),
      );

      const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, {
        preferFirstProviderForSource: true,
      });
      const providerInitialValue =
        existingRef?.source === source ? existingRef.provider : defaultAlias;
      const providerAlias = await promptRequiredText({
        message: "Provider alias",
        initialValue: providerInitialValue,
        validate: (value) =>
          isValidSecretProviderAlias(value) ? undefined : "Must match /^[a-z][a-z0-9_-]{0,63}$/",
      });
      const suggestedIdFromExistingRef =
        existingRef?.source === source ? existingRef.id : undefined;
      let suggestedId = suggestedIdFromExistingRef;
      if (!suggestedId && (source === "env" || source === "store")) {
        suggestedId = resolveSuggestedEnvSecretId(candidate);
      }
      if (!suggestedId && source === "file") {
        const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
        if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") {
          suggestedId = "value";
        }
      }
      const id = await promptRequiredText({
        message: "Secret id",
        initialValue: suggestedId,
        validate: (value) => {
          if ((source === "env" || source === "store") && !isValidEnvSecretRefId(value)) {
            return `${source} ids must match /^[A-Z][A-Z0-9_]{0,127}$/`;
          }
          return source === "exec" && !isValidExecSecretRefId(value)
            ? formatExecSecretRefIdValidationMessage()
            : undefined;
        },
      });
      const ref: SecretRef = {
        source,
        provider: providerAlias,
        id,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
