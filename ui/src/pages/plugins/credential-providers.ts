import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveDefaultSecretProviderAlias,
  type SecretRefSource,
} from "../../../../src/secrets/ref-contract.ts";

export const credentialSources = ["env", "file", "exec", "store"] as const;

/** Project only provider names and source defaults, never identifiers or secret values. */
export function resolveCredentialProviders(config: Record<string, unknown> | null) {
  const secrets = asNullableRecord(config?.secrets);
  const defaults = asNullableRecord(secrets?.defaults);
  const providers = asNullableRecord(secrets?.providers);
  const forSource = (source: SecretRefSource) => {
    const configuredDefault = defaults?.[source];
    const defaultAlias = resolveDefaultSecretProviderAlias(
      {
        secrets: {
          defaults: {
            [source]: typeof configuredDefault === "string" ? configuredDefault : undefined,
          },
        },
      },
      source,
    );
    const aliases = Object.entries(providers ?? {})
      .filter(([, provider]) => asNullableRecord(provider)?.source === source)
      .map(([alias]) => alias)
      .toSorted();
    // The resolver supplies built-in env/store readers at the effective default alias.
    if ((source === "env" || source === "store") && !aliases.includes(defaultAlias)) {
      aliases.unshift(defaultAlias);
    }
    return { defaultAlias, aliases };
  };
  return {
    env: forSource("env"),
    file: forSource("file"),
    exec: forSource("exec"),
    store: forSource("store"),
  };
}

export type CredentialProviders = ReturnType<typeof resolveCredentialProviders>;
