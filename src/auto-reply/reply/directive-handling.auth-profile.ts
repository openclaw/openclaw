// Parses auth profile directives into provider-scoped runtime overrides.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { findPersistedAuthProfileCredential } from "../../agents/auth-profiles/store.js";
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
    if (account.provider !== params.provider) {
      return {
        error: `Auth profile "${raw}" is for ${account.provider}, not ${params.provider}.`,
      };
    }
    return { profileId: raw, validateSelection };
  }
  // Persisted credentials are checked first because they avoid keychain prompts.
  const profile =
    findPersistedAuthProfileCredential({ agentDir: params.agentDir, profileId: raw }) ??
    ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw };
}
