import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretProviderConfig, SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { runSecretsApply, type SecretsApplyResult } from "./apply.js";
import { createSecretsConfigIO } from "./config-io.js";
import { type SecretsApplyPlan } from "./plan.js";
import { resolveDefaultSecretProviderAlias } from "./ref-contract.js";
import { isRecord } from "./shared.js";

type ConfigureCandidate = {
  type: "models.providers.apiKey" | "skills.entries.apiKey" | "channels.googlechat.serviceAccount";
  path: string;
  pathSegments: string[];
  label: string;
  providerId?: string;
  accountId?: string;
};

export type SecretsConfigureResult = {
  plan: SecretsApplyPlan;
  preflight: SecretsApplyResult;
};

const PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
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

function buildCandidates(config: OpenClawConfig): ConfigureCandidate[] {
  const out: ConfigureCandidate[] = [];
  const providers = config.models?.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const [providerId, providerValue] of Object.entries(providers)) {
      if (!isRecord(providerValue)) {
        continue;
      }
      out.push({
        type: "models.providers.apiKey",
        path: `models.providers.${providerId}.apiKey`,
        pathSegments: ["models", "providers", providerId, "apiKey"],
        label: `Provider API key: ${providerId}`,
        providerId,
      });
    }
  }

  const entries = config.skills?.entries as Record<string, unknown> | undefined;
  if (entries) {
    for (const [entryId, entryValue] of Object.entries(entries)) {
      if (!isRecord(entryValue)) {
        continue;
      }
      out.push({
        type: "skills.entries.apiKey",
        path: `skills.entries.${entryId}.apiKey`,
        pathSegments: ["skills", "entries", entryId, "apiKey"],
        label: `Skill API key: ${entryId}`,
      });
    }
  }

  const googlechat = config.channels?.googlechat;
  if (isRecord(googlechat)) {
    out.push({
      type: "channels.googlechat.serviceAccount",
      path: "channels.googlechat.serviceAccount",
      pathSegments: ["channels", "googlechat", "serviceAccount"],
      label: "Google Chat serviceAccount (default)",
    });
    const accounts = googlechat.accounts;
    if (isRecord(accounts)) {
      for (const [accountId, value] of Object.entries(accounts)) {
        if (!isRecord(value)) {
          continue;
        }
        out.push({
          type: "channels.googlechat.serviceAccount",
          path: `channels.googlechat.accounts.${accountId}.serviceAccount`,
          pathSegments: ["channels", "googlechat", "accounts", accountId, "serviceAccount"],
          label: `Google Chat serviceAccount (${accountId})`,
          accountId,
        });
      }
    }
  }

  return out;
}

function toSourceChoices(config: OpenClawConfig): Array<{ value: SecretRefSource; label: string }> {
  const hasSource = (source: SecretRefSource) =>
    Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
  const choices: Array<{ value: SecretRefSource; label: string }> = [
    {
      value: "env",
      label: "env",
    },
  ];
  if (hasSource("file")) {
    choices.push({ value: "file", label: "file" });
  }
  if (hasSource("exec")) {
    choices.push({ value: "exec", label: "exec" });
  }
  return choices;
}

function assertNoCancel<T>(value: T | symbol, message: string): T {
  if (typeof value === "symbol") {
    throw new Error(message);
  }
  return value;
}

async function promptProviderAlias(params: { existingAliases: Set<string> }): Promise<string> {
  const alias = assertNoCancel(
    await text({
      message: "Provider alias",
      initialValue: "default",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required";
        }
        if (!PROVIDER_ALIAS_PATTERN.test(trimmed)) {
          return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
        }
        if (params.existingAliases.has(trimmed)) {
          return "Alias already exists";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );
  return String(alias).trim();
}

async function promptProviderSource(initial?: SecretRefSource): Promise<SecretRefSource> {
  const source = assertNoCancel(
    await select({
      message: "Provider source",
      options: [
        { value: "env", label: "env" },
        { value: "file", label: "file" },
        { value: "exec", label: "exec" },
      ],
      initialValue: initial,
    }),
    "Secrets configure cancelled.",
  );
  return source as SecretRefSource;
}

async function promptEnvProvider(
  base?: Extract<SecretProviderConfig, { source: "env" }>,
): Promise<Extract<SecretProviderConfig, { source: "env" }>> {
  const allowlistRaw = assertNoCancel(
    await text({
      message: "Env allowlist (comma-separated, blank for unrestricted)",
      initialValue: base?.allowlist?.join(",") ?? "",
      validate: (value) => {
        const entries = parseCsv(String(value ?? ""));
        for (const entry of entries) {
          if (!ENV_NAME_PATTERN.test(entry)) {
            return `Invalid env name: ${entry}`;
          }
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );
  const allowlist = parseCsv(String(allowlistRaw ?? ""));
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
      message: "File path (absolute)",
      initialValue: base?.path ?? "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const mode = assertNoCancel(
    await select({
      message: "File mode",
      options: [
        { value: "json", label: "json" },
        { value: "singleValue", label: "singleValue" },
      ],
      initialValue: base?.mode ?? "json",
    }),
    "Secrets configure cancelled.",
  );

  const timeoutMsRaw = assertNoCancel(
    await text({
      message: "Timeout ms (blank for default)",
      initialValue: base?.timeoutMs ? String(base.timeoutMs) : "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return undefined;
        }
        if (parseOptionalPositiveInt(trimmed, 120000) === undefined) {
          return "Must be an integer between 1 and 120000";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );
  const maxBytesRaw = assertNoCancel(
    await text({
      message: "Max bytes (blank for default)",
      initialValue: base?.maxBytes ? String(base.maxBytes) : "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return undefined;
        }
        if (parseOptionalPositiveInt(trimmed, 20 * 1024 * 1024) === undefined) {
          return "Must be an integer between 1 and 20971520";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const timeoutMs = parseOptionalPositiveInt(String(timeoutMsRaw ?? ""), 120000);
  const maxBytes = parseOptionalPositiveInt(String(maxBytesRaw ?? ""), 20 * 1024 * 1024);

  return {
    source: "file",
    path: String(filePath).trim(),
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
  base?: Extract<SecretProviderConfig, { source: "exec" }>,
): Promise<Extract<SecretProviderConfig, { source: "exec" }>> {
  const command = assertNoCancel(
    await text({
      message: "Command path (absolute)",
      initialValue: base?.command ?? "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path";
        }
        if (!isSafeExecutableValue(trimmed)) {
          return "Command value is not allowed";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const argsRaw = assertNoCancel(
    await text({
      message: "Args JSON array (blank for none)",
      initialValue: JSON.stringify(base?.args ?? []),
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
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
    "Secrets configure cancelled.",
  );

  const timeoutMsRaw = assertNoCancel(
    await text({
      message: "Timeout ms (blank for default)",
      initialValue: base?.timeoutMs ? String(base.timeoutMs) : "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return undefined;
        }
        if (parseOptionalPositiveInt(trimmed, 120000) === undefined) {
          return "Must be an integer between 1 and 120000";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const noOutputTimeoutMsRaw = assertNoCancel(
    await text({
      message: "No-output timeout ms (blank for default)",
      initialValue: base?.noOutputTimeoutMs ? String(base.noOutputTimeoutMs) : "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return undefined;
        }
        if (parseOptionalPositiveInt(trimmed, 120000) === undefined) {
          return "Must be an integer between 1 and 120000";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const maxOutputBytesRaw = assertNoCancel(
    await text({
      message: "Max output bytes (blank for default)",
      initialValue: base?.maxOutputBytes ? String(base.maxOutputBytes) : "",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return undefined;
        }
        if (parseOptionalPositiveInt(trimmed, 20 * 1024 * 1024) === undefined) {
          return "Must be an integer between 1 and 20971520";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const jsonOnly = assertNoCancel(
    await confirm({
      message: "Require JSON-only response?",
      initialValue: base?.jsonOnly ?? true,
    }),
    "Secrets configure cancelled.",
  );

  const passEnvRaw = assertNoCancel(
    await text({
      message: "Pass-through env vars (comma-separated, blank for none)",
      initialValue: base?.passEnv?.join(",") ?? "",
      validate: (value) => {
        const entries = parseCsv(String(value ?? ""));
        for (const entry of entries) {
          if (!ENV_NAME_PATTERN.test(entry)) {
            return `Invalid env name: ${entry}`;
          }
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const trustedDirsRaw = assertNoCancel(
    await text({
      message: "Trusted dirs (comma-separated absolute paths, blank for none)",
      initialValue: base?.trustedDirs?.join(",") ?? "",
      validate: (value) => {
        const entries = parseCsv(String(value ?? ""));
        for (const entry of entries) {
          if (!isAbsolutePathValue(entry)) {
            return `Trusted dir must be absolute: ${entry}`;
          }
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const allowInsecurePath = assertNoCancel(
    await confirm({
      message: "Allow insecure command path checks?",
      initialValue: base?.allowInsecurePath ?? false,
    }),
    "Secrets configure cancelled.",
  );
  const allowSymlinkCommand = assertNoCancel(
    await confirm({
      message: "Allow symlink command path?",
      initialValue: base?.allowSymlinkCommand ?? false,
    }),
    "Secrets configure cancelled.",
  );

  const args = await parseArgsInput(String(argsRaw ?? ""));
  const timeoutMs = parseOptionalPositiveInt(String(timeoutMsRaw ?? ""), 120000);
  const noOutputTimeoutMs = parseOptionalPositiveInt(String(noOutputTimeoutMsRaw ?? ""), 120000);
  const maxOutputBytes = parseOptionalPositiveInt(
    String(maxOutputBytesRaw ?? ""),
    20 * 1024 * 1024,
  );
  const passEnv = parseCsv(String(passEnvRaw ?? ""));
  const trustedDirs = parseCsv(String(trustedDirsRaw ?? ""));

  return {
    source: "exec",
    command: String(command).trim(),
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
        label: "Add provider",
        hint: "Define a new env/file/exec provider",
      },
    ];
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
            : "Configure secret providers (only env refs are available until file/exec providers are added)",
        options: actionOptions,
      }),
      "Secrets configure cancelled.",
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
          message: "Select provider to edit",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            value: providerAlias,
            label: providerAlias,
            hint: providerHint(providerConfig),
          })),
        }),
        "Secrets configure cancelled.",
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
          message: "Select provider to remove",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            value: providerAlias,
            label: providerAlias,
            hint: providerHint(providerConfig),
          })),
        }),
        "Secrets configure cancelled.",
      );

      const shouldRemove = assertNoCancel(
        await confirm({
          message: `Remove provider "${alias}"?`,
          initialValue: false,
        }),
        "Secrets configure cancelled.",
      );
      if (shouldRemove) {
        removeSecretProvider(config, alias);
      }
    }
  }
}

function collectProviderPlanChanges(params: { original: OpenClawConfig; next: OpenClawConfig }): {
  upserts: Record<string, SecretProviderConfig>;
  deletes: string[];
} {
  const originalProviders = getSecretProviders(params.original);
  const nextProviders = getSecretProviders(params.next);

  const upserts: Record<string, SecretProviderConfig> = {};
  const deletes: string[] = [];

  for (const [providerAlias, nextProviderConfig] of Object.entries(nextProviders)) {
    const current = originalProviders[providerAlias];
    if (isDeepStrictEqual(current, nextProviderConfig)) {
      continue;
    }
    upserts[providerAlias] = structuredClone(nextProviderConfig);
  }

  for (const providerAlias of Object.keys(originalProviders)) {
    if (!Object.prototype.hasOwnProperty.call(nextProviders, providerAlias)) {
      deletes.push(providerAlias);
    }
  }

  return {
    upserts,
    deletes: deletes.toSorted(),
  };
}

export async function runSecretsConfigureInteractive(
  params: {
    env?: NodeJS.ProcessEnv;
    providersOnly?: boolean;
    skipProviderSetup?: boolean;
  } = {},
): Promise<SecretsConfigureResult> {
  if (!process.stdin.isTTY) {
    throw new Error("secrets configure requires an interactive TTY.");
  }
  if (params.providersOnly && params.skipProviderSetup) {
    throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
  }

  const env = params.env ?? process.env;
  const io = createSecretsConfigIO({ env });
  const { snapshot } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot run interactive secrets configure because config is invalid.");
  }

  const stagedConfig = structuredClone(snapshot.config);
  if (!params.skipProviderSetup) {
    await configureProvidersInteractive(stagedConfig);
  }

  const providerChanges = collectProviderPlanChanges({
    original: snapshot.config,
    next: stagedConfig,
  });

  const selectedByPath = new Map<string, ConfigureCandidate & { ref: SecretRef }>();
  if (!params.providersOnly) {
    const candidates = buildCandidates(stagedConfig);
    if (candidates.length === 0) {
      throw new Error("No configurable secret-bearing fields found in openclaw.json.");
    }

    const sourceChoices = toSourceChoices(stagedConfig);

    while (true) {
      const options = candidates.map((candidate) => ({
        value: candidate.path,
        label: candidate.label,
        hint: candidate.path,
      }));
      if (selectedByPath.size > 0) {
        options.unshift({
          value: "__done__",
          label: "Done",
          hint: "Finish and run preflight",
        });
      }

      const selectedPath = assertNoCancel(
        await select({
          message: "Select credential field",
          options,
        }),
        "Secrets configure cancelled.",
      );

      if (selectedPath === "__done__") {
        break;
      }

      const candidate = candidates.find((entry) => entry.path === selectedPath);
      if (!candidate) {
        throw new Error(`Unknown configure target: ${selectedPath}`);
      }

      const source = assertNoCancel(
        await select({
          message: "Secret source",
          options: sourceChoices,
        }),
        "Secrets configure cancelled.",
      ) as SecretRefSource;

      const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, {
        preferFirstProviderForSource: true,
      });
      const provider = assertNoCancel(
        await text({
          message: "Provider alias",
          initialValue: defaultAlias,
          validate: (value) => {
            const trimmed = String(value ?? "").trim();
            if (!trimmed) {
              return "Required";
            }
            if (!PROVIDER_ALIAS_PATTERN.test(trimmed)) {
              return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
            }
            return undefined;
          },
        }),
        "Secrets configure cancelled.",
      );
      const id = assertNoCancel(
        await text({
          message: "Secret id",
          validate: (value) => (String(value ?? "").trim().length > 0 ? undefined : "Required"),
        }),
        "Secrets configure cancelled.",
      );
      const ref: SecretRef = {
        source,
        provider: String(provider).trim(),
        id: String(id).trim(),
      };

      const next = {
        ...candidate,
        ref,
      };
      selectedByPath.set(candidate.path, next);

      const addMore = assertNoCancel(
        await confirm({
          message: "Configure another credential?",
          initialValue: true,
        }),
        "Secrets configure cancelled.",
      );
      if (!addMore) {
        break;
      }
    }
  }

  if (
    selectedByPath.size === 0 &&
    Object.keys(providerChanges.upserts).length === 0 &&
    providerChanges.deletes.length === 0
  ) {
    throw new Error("No secrets changes were selected.");
  }

  const plan: SecretsApplyPlan = {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "openclaw secrets configure",
    targets: [...selectedByPath.values()].map((entry) => ({
      type: entry.type,
      path: entry.path,
      pathSegments: [...entry.pathSegments],
      ref: entry.ref,
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
    })),
    ...(Object.keys(providerChanges.upserts).length > 0
      ? { providerUpserts: providerChanges.upserts }
      : {}),
    ...(providerChanges.deletes.length > 0 ? { providerDeletes: providerChanges.deletes } : {}),
    options: {
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    },
  };

  const preflight = await runSecretsApply({
    plan,
    env,
    write: false,
  });

  return { plan, preflight };
}
