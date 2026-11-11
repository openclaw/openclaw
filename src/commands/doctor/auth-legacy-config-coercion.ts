import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope-config.js";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import {
  coerceLegacyAuthProfileStore,
  coerceLegacyFlatCredential,
} from "../../agents/auth-profiles/legacy-flat-credential.js";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";

type RawAuthProfileImportStore = {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
  order?: Record<string, string[]>;
};

export function isSafeLegacyProviderKey(key: string): boolean {
  return key.trim().length > 0 && !isBlockedObjectKey(key);
}

export function extractProviderPrefix(value: string, separator: ":" | "/"): string | undefined {
  const index = value.indexOf(separator);
  return index > 0 ? readNonEmptyString(value.slice(0, index)) : undefined;
}

function extractProviderFromModelRef(modelRef: string): string | undefined {
  return extractProviderPrefix(splitTrailingAuthProfile(modelRef).model, "/");
}

function collectLegacyConfigAuthProfileProviderHints(
  cfg: OpenClawConfig,
): ReadonlyMap<string, string | null> {
  const hints = new Map<string, string | null>();
  const addHint = (profileId: string, provider: string): void => {
    const existing = hints.get(profileId);
    // Ambiguous evidence stays ambiguous even if a later reference repeats one provider.
    hints.set(profileId, existing === undefined || existing === provider ? provider : null);
  };
  const addModelHints = (models: unknown): void => {
    if (!isRecord(models)) {
      return;
    }
    for (const [modelRef, rawModel] of Object.entries(models)) {
      const provider = extractProviderFromModelRef(modelRef);
      if (!provider || !isSafeLegacyProviderKey(provider) || !isRecord(rawModel)) {
        continue;
      }
      const agentRuntime = isRecord(rawModel.agentRuntime) ? rawModel.agentRuntime : null;
      const authProfileId = agentRuntime
        ? readNonEmptyString(agentRuntime.authProfileId)
        : undefined;
      if (authProfileId) {
        addHint(authProfileId, provider);
      }
    }
  };

  for (const { value } of collectConfiguredModelRefs(cfg)) {
    const { profile } = splitTrailingAuthProfile(value);
    const provider = extractProviderFromModelRef(value);
    if (profile && provider && isSafeLegacyProviderKey(provider)) {
      addHint(profile, provider);
    }
  }

  const root: Record<string, unknown> = cfg;
  const auth = isRecord(root.auth) ? root.auth : null;
  const order = auth && isRecord(auth.order) ? auth.order : null;
  if (order) {
    for (const [provider, profileIds] of Object.entries(order)) {
      if (!isSafeLegacyProviderKey(provider) || !Array.isArray(profileIds)) {
        continue;
      }
      for (const profileId of profileIds) {
        const normalizedProfileId = readNonEmptyString(profileId);
        if (normalizedProfileId) {
          addHint(normalizedProfileId, provider);
        }
      }
    }
  }
  const agents = isRecord(root.agents) ? root.agents : null;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
  addModelHints(defaults?.models);
  for (const agent of listAgentEntries(cfg)) {
    addModelHints(agent.models);
  }
  return hints;
}

export function coerceLegacyFlatAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw) || "profiles" in raw) {
    return null;
  }
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  for (const [key, value] of Object.entries(raw)) {
    const providerId = key.trim();
    if (!isSafeLegacyProviderKey(providerId)) {
      continue;
    }
    const credential = coerceLegacyFlatCredential(providerId, value);
    if (!credential) {
      continue;
    }
    store.profiles[`${providerId}:default`] = credential;
  }
  return Object.keys(store.profiles).length > 0 ? store : null;
}

const CONFIG_AUTH_VALUE_FIELDS = {
  api_key: ["key", "apiKey", "api_key"],
  token: ["token"],
} as const;

function readConfigAuthAlias<T>(
  raw: Record<string, unknown>,
  fields: readonly string[],
  read: (value: unknown) => T | null | undefined,
): T | undefined {
  for (const field of fields) {
    const value = read(raw[field]);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

function inferLegacyConfigAuthProfileMode(
  raw: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(raw.mode) ?? readNonEmptyString(raw.type);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  for (const mode of ["api_key", "token"] as const) {
    const fields = CONFIG_AUTH_VALUE_FIELDS[mode];
    if (
      readConfigAuthAlias(raw, fields, readNonEmptyString) ||
      readConfigAuthAlias(raw, [`${fields[0]}Ref`, ...fields], coerceSecretRef)
    ) {
      return mode;
    }
  }
  if (
    readNonEmptyString(raw.access) &&
    readNonEmptyString(raw.refresh) &&
    typeof raw.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

export function coerceLegacyConfigAuthProfileStore(cfg: OpenClawConfig): AuthProfileStore | null {
  const cfgRecord: Record<string, unknown> = cfg;
  const auth = isRecord(cfgRecord.auth) ? cfgRecord.auth : null;
  const profiles = auth && isRecord(auth.profiles) ? auth.profiles : null;
  if (!profiles) {
    return null;
  }
  const providerHints = collectLegacyConfigAuthProfileProviderHints(cfg);
  const store: RawAuthProfileImportStore = { version: AUTH_STORE_VERSION, profiles: {} };
  for (const [profileId, raw] of Object.entries(profiles)) {
    if (!isRecord(raw)) {
      continue;
    }
    const mode = inferLegacyConfigAuthProfileMode(raw);
    if (!mode) {
      continue;
    }
    const provider =
      readNonEmptyString(raw.provider) ??
      extractProviderPrefix(profileId, ":") ??
      providerHints.get(profileId);
    if (!provider || !isSafeLegacyProviderKey(provider)) {
      continue;
    }
    const next: Record<string, unknown> = { ...raw, provider, mode };
    if (mode === "api_key" || mode === "token") {
      const fields = CONFIG_AUTH_VALUE_FIELDS[mode];
      const valueField = fields[0];
      const refField = `${valueField}Ref`;
      const ref = readConfigAuthAlias(raw, [refField, ...fields], coerceSecretRef);
      const value = readConfigAuthAlias(raw, fields, readNonEmptyString);
      if (ref) {
        next[refField] = ref;
        for (const field of fields) {
          delete next[field];
        }
      } else if (value) {
        next[valueField] = value;
        delete next[refField];
      } else {
        continue;
      }
    } else if (
      !readNonEmptyString(raw.access) ||
      !readNonEmptyString(raw.refresh) ||
      typeof raw.expires !== "number"
    ) {
      continue;
    }
    store.profiles[profileId] = next;
  }
  const canonicalStore = coerceLegacyAuthProfileStore(store);
  return canonicalStore && Object.keys(canonicalStore.profiles).length > 0 ? canonicalStore : null;
}
