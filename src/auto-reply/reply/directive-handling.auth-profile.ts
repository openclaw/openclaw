import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ensureAuthProfileStoreAsync,
  findPersistedAuthProfileCredentialAsync,
} from "../../agents/auth-profiles/store-runtime.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { prepareUserModelAccountAuthority } from "../../state/user-model-account-operations.js";

/** Resolves a user-selected auth profile override for the requested provider. */
export async function resolveProfileOverride(params: {
  rawProfile?: string;
  provider: string;
  agentDir?: string;
  requesterProfileId?: string;
}): Promise<{ profileId?: string; error?: string; validateSelection?: () => string | undefined }> {
  const raw = normalizeOptionalString(params.rawProfile);
  if (!raw) {
    return {};
  }
  const selectProfile = (provider: string, validateSelection?: () => string | undefined) =>
    provider !== params.provider
      ? { error: `Auth profile "${raw}" is for ${provider}, not ${params.provider}.` }
      : { profileId: raw, ...(validateSelection ? { validateSelection } : {}) };
  const requesterProfileId = params.requesterProfileId;
  if (isUserModelAuthProfileId(raw)) {
    const account = requesterProfileId
      ? await prepareUserModelAccountAuthority({
          profileId: requesterProfileId,
          authProfileId: raw,
        })
      : undefined;
    const unavailable = "Select a personal model account connected to your signed-in profile.";
    if (!account) {
      return { error: unavailable };
    }
    const validateSelection = () => (account.isCurrent() ? undefined : unavailable);
    const selectionError = validateSelection();
    if (selectionError) {
      return { error: selectionError };
    }
    return selectProfile(account.provider, validateSelection);
  }
  // Persisted credentials are checked first because they avoid keychain prompts.
  const profile =
    (await findPersistedAuthProfileCredentialAsync({
      agentDir: params.agentDir,
      profileId: raw,
    })) ??
    (await ensureAuthProfileStoreAsync(params.agentDir, { allowKeychainPrompt: false })).profiles[
      raw
    ];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  return selectProfile(profile.provider);
}
