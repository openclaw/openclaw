import { isDeepStrictEqual } from "node:util";
import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../../agents/auth-profiles/candidate-stores.js";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import {
  resolveProviderConfigSecretInput,
  resolveProviderEntryApiKeyProfileReference,
} from "../../agents/model-auth-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
  validateOpenAICodexApiKeyInput,
} from "./auth-manual-input.js";
import { loadValidConfigSnapshotOrThrow, updateConfig } from "./shared.js";

/** Saves a manual key without changing model selection or connection settings. */
export async function saveModelProviderApiKey(params: {
  config?: OpenClawConfig;
  provider: string;
  apiKey: string;
  profileId?: string;
  agentDir: string;
}): Promise<string> {
  const provider = normalizeManualAuthProvider(params.provider);
  const key = normalizeSecretInput(params.apiKey);
  registerSecretValueForRedaction(key);
  const validationError = !key
    ? "API key is required"
    : provider === "openai"
      ? validateOpenAICodexApiKeyInput(key)
      : undefined;
  if (validationError) {
    throw new Error(validationError);
  }
  const config = params.config ?? (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  const validateCurrentCredential = (existing: AuthProfileCredential | undefined) => {
    if (existing?.type === "api_key" && existing.keyRef) {
      throw new Error(
        "This API-key profile uses an external secret reference. Remove that saved sign-in before storing an inline key.",
      );
    }
    if (
      existing &&
      (existing.type !== "api_key" || normalizeProviderId(existing.provider) !== provider)
    ) {
      throw new Error(
        "The API-key profile belongs to another sign-in. Manage that saved sign-in first.",
      );
    }
  };
  const configuredKey = (cfg: OpenClawConfig) => {
    const id = findNormalizedProviderKey(cfg.models?.providers, provider);
    const connection = id ? cfg.models?.providers?.[id] : undefined;
    if (connection?.auth && connection.auth !== "api-key") {
      throw new Error(
        "This connection uses another sign-in method. Use its sign-in option instead.",
      );
    }
    return id;
  };
  const configuredBinding = (cfg: OpenClawConfig, providerId: string) => {
    const { providerConfig, ref } = resolveProviderConfigSecretInput(cfg, providerId);
    return ref ?? providerConfig?.apiKey;
  };
  const connectionId = params.profileId ? undefined : configuredKey(config);
  const connectionBinding =
    connectionId === undefined ? undefined : configuredBinding(config, connectionId);
  const store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir);
  const replacementId = !connectionId
    ? resolveAuthProfileOrder({ cfg: config, store, provider }).find((id) => {
        const credential = store.profiles[id];
        return credential?.type === "api_key" && !credential.keyRef;
      })
    : undefined;
  const configuredReference = connectionId
    ? resolveProviderEntryApiKeyProfileReference({ cfg: config, provider: connectionId, store })
    : undefined;
  const configuredProfileId =
    configuredReference?.kind === "profile" || configuredReference?.kind === "profile-incompatible"
      ? configuredReference.profileId
      : undefined;
  const profileId =
    params.profileId ??
    configuredProfileId ??
    replacementId ??
    resolveDefaultTokenProfileId(provider);
  if (isUserModelAuthProfileId(profileId)) {
    throw new Error(
      "Personal model accounts are managed in Settings → Profile → Connected accounts.",
    );
  }
  const agentDir = connectionId
    ? undefined
    : store.profiles[profileId]
      ? resolvePersistedAuthProfileOwnerAgentDir({ agentDir: params.agentDir, profileId })
      : params.agentDir;
  const localCandidates = connectionId
    ? (await listCandidateAuthProfileStores({ cfg: config })).filter(
        (candidate) =>
          candidate.databasePath !==
          resolvePathViaExistingAncestorSync(resolveSharedAuthStorePath()),
      )
    : [];
  const validateSharedBinding = () => {
    if (
      localCandidates.some(
        (candidate) => loadCandidateAuthProfileStore(candidate)?.profiles[profileId],
      )
    ) {
      throw new Error(
        "An agent already overrides this shared key. Remove that agent's override before replacing the shared key.",
      );
    }
  };
  const validateReplacement = (existing: AuthProfileCredential | undefined) => {
    validateCurrentCredential(existing);
    validateSharedBinding();
  };
  validateReplacement(store.profiles[profileId]);
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: { type: "api_key", provider, key },
    agentDir,
    preserveApiKeyMetadata: true,
    validateCurrentCredential: validateReplacement,
  });
  await updateConfig((current) => {
    const id = params.profileId ? undefined : configuredKey(current);
    if (
      !params.profileId &&
      (id !== connectionId ||
        (id !== undefined && !isDeepStrictEqual(configuredBinding(current, id), connectionBinding)))
    ) {
      throw new Error(
        "The provider connection changed during the key update. Reopen the connection and save the key again",
      );
    }
    validateSharedBinding();
    const next = applyAuthProfileConfig(current, {
      ...current.auth?.profiles?.[profileId],
      profileId,
      provider,
      mode: "api_key",
    });
    if (!id || !next.models?.providers?.[id]) {
      return next;
    }
    return {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models.providers,
          [id]: { ...next.models.providers[id], apiKey: profileId },
        },
      },
    };
  }).catch((error: unknown) => {
    throw new Error(
      "API key saved, but provider settings could not be applied: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Reopen Models and save the key again.",
      { cause: error },
    );
  });
  return profileId;
}
