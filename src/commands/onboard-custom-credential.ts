/**
 * Persists custom-provider credentials into the agent auth store.
 *
 * Interactive and non-interactive custom provider setup share this module so
 * the credential lands in the right store at write time instead of waiting for
 * doctor's catalog-credential repair.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OnboardingAgentTarget } from "./onboard-agent-target.js";

/**
 * Allocates the auth-store profile id for a custom-provider credential, using
 * the same naming as doctor's catalog migration. A same-provider api_key
 * profile is setup-owned: a re-onboarded key replaces it in place.
 */
function allocateCustomProviderProfileId(store: AuthProfileStore, provider: string): string {
  for (let suffix = 1; ; suffix += 1) {
    const profileId =
      suffix === 1
        ? `${provider}:default`
        : `${provider}:models-json${suffix === 2 ? "" : `-${suffix}`}`;
    const existing = store.profiles[profileId];
    if (
      !existing ||
      (existing.type === "api_key" && normalizeProviderId(existing.provider ?? "") === provider)
    ) {
      return profileId;
    }
  }
}

/**
 * Lands a literal custom-provider credential in the target agent's auth store
 * at setup time, so `openclaw doctor` has nothing to repair afterward: its
 * catalog-credential check skips plaintext values that already match a stored
 * profile. The config catalog copy remains the active runtime credential,
 * matching doctor's own migration end state. Env-ref and marker values are not
 * secrets to store and stay config-owned.
 *
 * The config catalog entry is global, and doctor's check matches plaintext
 * against the shared main store only — so when the target is a different
 * agent dir, the profile is mirrored into the shared main store as well. No
 * custom provider add should ever leave doctor something to repair.
 */
export async function persistCustomProviderCredential(params: {
  config: OpenClawConfig;
  providerId: string;
  target?: OnboardingAgentTarget;
}): Promise<void> {
  if (!params.providerId) {
    return;
  }
  const apiKey = params.config.models?.providers?.[params.providerId]?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim() || isNonSecretApiKeyMarker(apiKey)) {
    return;
  }
  const provider = normalizeProviderId(params.providerId);
  const agentDir =
    params.target?.agentDir ?? resolveAgentDir(params.config, resolveDefaultAgentId(params.config));
  const mainAgentDir = resolveSharedMainAuthAgentDir();
  const storeDirs = agentDir === mainAgentDir ? [agentDir] : [agentDir, mainAgentDir];
  for (const storeDir of storeDirs) {
    // A null return means SQLite lock contention swallowed the write; treating
    // it as success would leave doctor's repair prompt as a surprise.
    const updated = await updateAuthProfileStoreWithLock({
      agentDir: storeDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater: (store) => {
        const profileId = allocateCustomProviderProfileId(store, provider);
        const existing = store.profiles[profileId];
        if (existing?.type === "api_key" && existing.key === apiKey) {
          return false;
        }
        store.profiles[profileId] = { type: "api_key", provider, key: apiKey };
        return true;
      },
    });
    if (!updated) {
      throw new Error(`agent auth profile store could not be updated (${storeDir})`);
    }
  }
}
