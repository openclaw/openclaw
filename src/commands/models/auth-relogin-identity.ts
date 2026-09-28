import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { listRuntimeLocalProfileIds } from "../../agents/auth-profiles/runtime-snapshot-owner.js";
import { resolveSharedMainAuthAgentDir } from "../../agents/auth-profiles/shared-main-dir.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../../plugins/types.js";

type AccountMatcher = ProviderAuthMethod["matchesPersonalAccount"];

export function snapshotReloginAuthProfiles(params: {
  agentDir: string;
  matchesPersonalAccount?: AccountMatcher;
}): Readonly<Record<string, AuthProfileCredential>> | undefined {
  if (!params.matchesPersonalAccount) {
    return undefined;
  }
  // Main-agent OAuth writes are redirected to the shared owner. Read that owner
  // directly so its profiles are local candidates, while derived agents still
  // exclude credentials inherited from the shared store.
  const storeAgentDir =
    path.resolve(params.agentDir) === path.resolve(resolveSharedMainAuthAgentDir())
      ? undefined
      : params.agentDir;
  const store = loadAuthProfileStoreWithoutExternalProfiles(storeAgentDir);
  return Object.fromEntries(
    listRuntimeLocalProfileIds(store).flatMap((profileId) => {
      const credential = store.profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
}

export function resolveReloginProfileIdentity(params: {
  profiles: ProviderAuthResult["profiles"];
  requestedProfileId?: string;
  existingProfiles?: Readonly<Record<string, AuthProfileCredential>>;
  matchesPersonalAccount?: AccountMatcher;
  allowMissingReusedProfile?: boolean;
}): {
  profiles: ProviderAuthResult["profiles"];
  validateCurrentCredential?: (
    profileId: string,
    credential: AuthProfileCredential | undefined,
  ) => void;
} {
  const requestedProfileId = params.requestedProfileId?.trim();
  if (requestedProfileId) {
    if (params.profiles.length !== 1) {
      throw new Error(
        "--profile-id requires exactly one returned auth profile from the selected auth method.",
      );
    }
    return {
      profiles: [
        {
          ...expectDefined(params.profiles[0], "auth profile"),
          profileId: requestedProfileId,
        },
      ],
    };
  }

  const matcher = params.matchesPersonalAccount;
  if (!matcher || !params.existingProfiles || params.profiles.length !== 1) {
    return { profiles: params.profiles };
  }
  const returnedProfile = expectDefined(params.profiles[0], "auth profile");
  const matchingProfileIds: string[] = [];
  for (const [profileId, credential] of Object.entries(params.existingProfiles)) {
    try {
      if (matcher(returnedProfile.credential, credential)) {
        matchingProfileIds.push(profileId);
      }
    } catch {
      return { profiles: params.profiles };
    }
  }
  if (matchingProfileIds.length !== 1) {
    return { profiles: params.profiles };
  }

  const reusedProfileId = expectDefined(matchingProfileIds[0], "matched auth profile id");
  return {
    profiles: [{ ...returnedProfile, profileId: reusedProfileId }],
    validateCurrentCredential: (profileId, current) => {
      let currentMatches = false;
      if (current) {
        try {
          currentMatches = matcher(returnedProfile.credential, current);
        } catch {
          currentMatches = false;
        }
      }
      if (
        profileId !== reusedProfileId ||
        (current ? !currentMatches : !params.allowMissingReusedProfile)
      ) {
        throw new Error(
          "The existing auth profile identity changed during sign-in. Start the sign-in again.",
        );
      }
    },
  };
}
