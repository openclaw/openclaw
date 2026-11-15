/** Resolves provider auth secret refs from env, file, exec, and store-backed providers. */
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { isValidEnvSecretRefId, type SecretRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  resolveDefaultSecretProviderAlias,
} from "../secrets/ref-contract.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;

type SecretRefChoice = "env" | "store" | "provider"; // pragma: allowlist secret

/** Copy overrides used while prompting for provider secret-ref setup. */
export type SecretRefSetupPromptCopy = {
  sourceMessage?: string;
  envVarMessage?: string;
  envVarPlaceholder?: string;
  envVarFormatError?: string;
  envVarMissingError?: (envVar: string) => string;
  noProvidersMessage?: string;
  envValidatedMessage?: (envVar: string) => string;
  providerValidatedMessage?: (
    provider: string,
    id: string,
    source: "file" | "exec" | "store",
  ) => string;
};

/** Extracts a trailing env var name from a human-facing secret source label. */
export function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

function resolveDefaultProviderEnvVar(
  provider: string,
  config?: OpenClawConfig,
): string | undefined {
  const envVars = getProviderEnvVarsCore(provider, {
    ...(config ? { config } : {}),
    includeUntrustedWorkspacePlugins: false,
  });
  return envVars?.find((candidate) => normalizeOptionalString(candidate) !== undefined);
}

export function resolveRefFallbackInput(params: {
  config: OpenClawConfig;
  provider: string;
  preferredEnvVar?: string;
  env?: NodeJS.ProcessEnv;
}): { ref: SecretRef; resolvedValue: string } {
  const fallbackEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider, params.config);
  if (!fallbackEnvVar) {
    throw new Error(
      `No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run setup in an interactive terminal to configure a ref.`,
    );
  }
  const env = params.env ?? process.env;
  const value = normalizeOptionalString(env[fallbackEnvVar]);
  if (!value) {
    throw new Error(
      `Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive setup.`,
    );
  }
  return {
    ref: {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(params.config, "env", {
        preferFirstProviderForSource: true,
      }),
      id: fallbackEnvVar,
    },
    resolvedValue: value,
  };
}

export async function promptSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider, params.config) ?? "";
  const defaultFilePointer = `/providers/${encodeJsonPointerToken(params.provider)}/apiKey`;
  let sourceChoice: SecretRefChoice = "env"; // pragma: allowlist secret

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      message: params.copy?.sourceMessage ?? "Where is this API key stored?",
      initialValue: sourceChoice,
      options: [
        {
          value: "env",
          label: "Environment variable",
          hint: "Reference a variable from your runtime environment",
        },
        {
          value: "store",
          label: "OpenClaw secret store",
          hint: "Reference a team-scoped value in the shared state database",
        },
        {
          value: "provider",
          label: "Configured secret provider",
          hint: "Use a configured file, exec, or store secret provider",
        },
      ],
    });
    const source: SecretRefChoice =
      sourceRaw === "provider" ? "provider" : sourceRaw === "store" ? "store" : "env";
    sourceChoice = source;

    if (source === "env") {
      const { provider, config, prompter, copy, env: promptEnv } = params;
      const env = promptEnv ?? process.env;
      const envVarRaw = await prompter.text({
        message: copy?.envVarMessage ?? "Environment variable name",
        initialValue: defaultEnvVar || undefined,
        placeholder: copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
        validate: (value) => {
          const candidate = value.trim();
          if (!isValidEnvSecretRefId(candidate)) {
            return (
              copy?.envVarFormatError ??
              'Use an env var name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).'
            );
          }
          if (!normalizeOptionalString(env[candidate])) {
            return (
              copy?.envVarMissingError?.(candidate) ??
              `Environment variable "${candidate}" is missing or empty in this session.`
            );
          }
          return undefined;
        },
      });
      const envCandidate = normalizeStringifiedOptionalString(envVarRaw) ?? "";
      const envVar =
        envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : defaultEnvVar;
      if (!envVar) {
        throw new Error(`No valid environment variable name provided for provider "${provider}".`);
      }
      const resolvedValue = normalizeOptionalString(env[envVar]);
      if (!resolvedValue) {
        throw new Error(`Environment variable "${envVar}" is missing or empty in this session.`);
      }
      const ref: SecretRef = {
        source: "env",
        provider: resolveDefaultSecretProviderAlias(config, "env", {
          preferFirstProviderForSource: true,
        }),
        id: envVar,
      };
      await prompter.note(
        copy?.envValidatedMessage?.(envVar) ??
          `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`,
        "Reference validated",
      );
      return { ref, resolvedValue };
    }

    if (source === "store") {
      const idRaw = await params.prompter.text({
        message: "Secret store name",
        initialValue: defaultEnvVar || undefined,
        placeholder: "OPENAI_API_KEY",
        validate: (value) =>
          isValidEnvSecretRefId(value.trim())
            ? undefined
            : 'Use a store name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).',
      });
      const id = normalizeStringifiedOptionalString(idRaw) ?? defaultEnvVar;
      const ref: SecretRef = {
        source: "store",
        provider: resolveDefaultSecretProviderAlias(params.config, "store", {
          preferFirstProviderForSource: true,
        }),
        id,
      };
      const { resolveSecretRefString } = await import("../secrets/resolve.js");
      const resolvedValue = await resolveSecretRefString(ref, {
        config: params.config,
        env: params.env ?? process.env,
      });
      await params.prompter.note(
        `Validated store reference ${ref.provider}:${id}. OpenClaw will store a reference, not the value.`,
        "Reference validated",
      );
      return { ref, resolvedValue };
    }

    if (source === "provider") {
      const { provider, config, prompter, copy, env } = params;
      const externalProviders = Object.entries(config.secrets?.providers ?? {}).filter(
        ([, secretProvider]) =>
          secretProvider?.source === "file" ||
          secretProvider?.source === "exec" ||
          secretProvider?.source === "store",
      );
      if (externalProviders.length === 0) {
        await prompter.note(
          copy?.noProvidersMessage ??
            "No file/exec/store secret providers are configured yet. Add one under secrets.providers, or select a built-in source.",
          "No providers configured",
        );
        continue;
      }

      const defaultProvider = resolveDefaultSecretProviderAlias(config, "file", {
        preferFirstProviderForSource: true,
      });
      const selectedProvider = await prompter.select<string>({
        message: "Select secret provider",
        initialValue:
          externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
          externalProviders[0]?.[0],
        options: externalProviders.map(([providerName, secretProvider]) => ({
          value: providerName,
          label: providerName,
          hint:
            secretProvider?.source === "exec"
              ? "Exec provider"
              : secretProvider?.source === "store"
                ? "Store provider"
                : "File provider",
        })),
      });
      const providerEntry = config.secrets?.providers?.[selectedProvider];
      if (
        !providerEntry ||
        (providerEntry.source !== "file" &&
          providerEntry.source !== "exec" &&
          providerEntry.source !== "store")
      ) {
        await prompter.note(
          `Provider "${selectedProvider}" is not a file/exec/store provider.`,
          "Invalid provider",
        );
        continue;
      }

      const idInput =
        providerEntry.source === "file"
          ? {
              message: "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)",
              initialValue: providerEntry.mode === "singleValue" ? "value" : defaultFilePointer,
              placeholder: "/providers/openai/apiKey",
              validate: (candidate: string) =>
                providerEntry.mode === "singleValue"
                  ? candidate === "value"
                    ? undefined
                    : 'singleValue mode expects id "value".'
                  : isValidFileSecretRefId(candidate)
                    ? undefined
                    : 'Use an absolute JSON pointer like "/providers/openai/apiKey".',
            }
          : providerEntry.source === "store"
            ? {
                message: "Secret store name",
                initialValue: resolveDefaultProviderEnvVar(provider, config) ?? "",
                placeholder: "OPENAI_API_KEY",
                validate: (candidate: string) =>
                  isValidEnvSecretRefId(candidate)
                    ? undefined
                    : 'Use a store name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).',
              }
            : {
                message: "Secret id for the exec provider",
                initialValue: `${provider}/apiKey`,
                placeholder: "openai/api-key",
                validate: (candidate: string) =>
                  isValidExecSecretRefId(candidate)
                    ? undefined
                    : formatExecSecretRefIdValidationMessage(),
              };
      const idRaw = await prompter.text({
        ...idInput,
        validate: (value) => {
          const candidate = value.trim();
          return candidate ? idInput.validate(candidate) : "Secret id cannot be empty.";
        },
      });
      const id = normalizeStringifiedOptionalString(idRaw) || idInput.initialValue;
      const ref: SecretRef = {
        source: providerEntry.source,
        provider: selectedProvider,
        id,
      };

      try {
        const { resolveSecretRefString } = await import("../secrets/resolve.js");
        const resolvedValue = await resolveSecretRefString(ref, {
          config,
          env: env ?? process.env,
        });
        await prompter.note(
          copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ??
            `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`,
          "Reference validated",
        );
        return { ref, resolvedValue };
      } catch (error) {
        await prompter.note(
          [
            `Could not validate provider reference ${selectedProvider}:${id}.`,
            formatErrorMessage(error),
            "Check your provider configuration and try again.",
          ].join("\n"),
          "Reference check failed",
        );
      }
    }
  }
}
