import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { listRuntimeLocalProfileIds } from "../../agents/auth-profiles/runtime-snapshot-owner.js";
import { resolveSharedMainAuthAgentDir } from "../../agents/auth-profiles/shared-main-dir.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../../plugins/types.js";

type ReloginMethod = Pick<
  ProviderAuthMethod,
  "matchesPersonalAccount" | "matchesSharedAccount" | "canReplaceGeneratedProfile"
>;

export async function snapshotReloginAuthProfiles(params: {
  agentDir: string;
  method: ReloginMethod;
}): Promise<Readonly<Record<string, AuthProfileCredential>> | undefined> {
  if (!(params.method.matchesSharedAccount ?? params.method.matchesPersonalAccount)) {
    return undefined;
  }
  // Main-agent OAuth writes are redirected to the shared owner. Read that owner
  // directly so its profiles are local candidates, while derived agents still
  // exclude credentials inherited from the shared store.
  const storeAgentDir =
    path.resolve(params.agentDir) === path.resolve(resolveSharedMainAuthAgentDir())
      ? undefined
      : params.agentDir;
  const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(storeAgentDir);
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
  method?: ReloginMethod;
  allowMissingReusedProfile?: boolean;
}) {
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

  const canReplaceGeneratedProfile = params.method?.canReplaceGeneratedProfile;
  const generated = {
    profiles: params.profiles,
    ...(canReplaceGeneratedProfile && {
      validateCurrentCredential: (
        profileId: string,
        current: AuthProfileCredential | undefined,
      ) => {
        if (!current) {
          return;
        }
        const profile = params.profiles.find((candidate) => candidate.profileId === profileId);
        // The writer supplies the authoritative row, including other providers.
        if (
          !profile ||
          current.provider !== profile.credential.provider ||
          !canReplaceGeneratedProfile(profile.credential, current)
        ) {
          throw new Error(
            "The automatic auth profile ID is already in use. Use a different profile ID with --profile-id when signing in from the CLI.",
          );
        }
      },
    }),
  };
  const matcher = params.method?.matchesSharedAccount ?? params.method?.matchesPersonalAccount;
  if (!matcher || !params.existingProfiles || params.profiles.length !== 1) {
    return generated;
  }
  const returnedProfile = expectDefined(params.profiles[0], "auth profile");
  const matchingProfileIds: string[] = [];
  for (const [profileId, credential] of Object.entries(params.existingProfiles)) {
    try {
      if (matcher(returnedProfile.credential, credential)) {
        matchingProfileIds.push(profileId);
      }
    } catch {
      return generated;
    }
  }
  if (matchingProfileIds.length !== 1) {
    return generated;
  }

  const reusedProfileId = expectDefined(matchingProfileIds[0], "matched auth profile id");
  return {
    profiles: [{ ...returnedProfile, profileId: reusedProfileId }],
    validateCurrentCredential: (profileId: string, current: AuthProfileCredential | undefined) => {
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
