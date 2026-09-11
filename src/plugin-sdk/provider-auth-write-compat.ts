import { removeProviderAuthProfilesWithLock as removeProviderAuthProfilesWithLockStrict } from "../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock as updateAuthProfileStoreWithLockStrict } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  upsertAuthProfileWithLock as upsertAuthProfileWithLockStrict,
  upsertAuthProfileWithLockOrThrow as upsertAuthProfileWithLockOrThrowStrict,
} from "../agents/auth-profiles/upsert-with-lock.js";

type AuthProfileUpsertParams = {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
};

// These Plugin SDK exports shipped with nullable failure semantics. Core callers use the
// strict helpers directly so plugins retain the stable contract without masking core failures.
export async function updateAuthProfileStoreWithLockCompat(
  params: Parameters<typeof updateAuthProfileStoreWithLockStrict>[0],
): Promise<AuthProfileStore | null> {
  try {
    return await updateAuthProfileStoreWithLockStrict(params);
  } catch {
    return null;
  }
}

export async function upsertAuthProfileWithLockCompat({
  profileId,
  credential,
  agentDir,
  stateDir,
}: AuthProfileUpsertParams): Promise<AuthProfileStore | null> {
  try {
    return await upsertAuthProfileWithLockStrict({ profileId, credential, agentDir, stateDir });
  } catch {
    return null;
  }
}

export async function upsertAuthProfileWithLockOrThrowCompat({
  profileId,
  credential,
  agentDir,
  stateDir,
}: AuthProfileUpsertParams): Promise<void> {
  await upsertAuthProfileWithLockOrThrowStrict({ profileId, credential, agentDir, stateDir });
}

export async function removeProviderAuthProfilesWithLockCompat(
  params: Parameters<typeof removeProviderAuthProfilesWithLockStrict>[0],
): Promise<AuthProfileStore | null> {
  try {
    return await removeProviderAuthProfilesWithLockStrict(params);
  } catch {
    return null;
  }
}
