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

function sharedAccountMatcher(method: ReloginMethod | undefined) {
  return method?.matchesSharedAccount ?? method?.matchesPersonalAccount;
}

export function listProviderReloginProfiles(
  stored: Readonly<Record<string, AuthProfileCredential>>,
  { provider, profileId: requestedId }: { provider: { id: string }; profileId?: string },
): ProviderAuthResult["profiles"] {
  return Object.entries(stored)
    .filter(
      ([id, credential]) =>
        credential.provider === provider.id && (!requestedId || id === requestedId),
    )
    .map(([profileId, credential]) => ({ profileId, credential }));
}

export async function snapshotReloginAuthProfiles(params: {
  agentDir: string;
  method: ReloginMethod;
  force?: boolean;
}): Promise<Readonly<Record<string, AuthProfileCredential>> | undefined> {
  if (!sharedAccountMatcher(params.method) && !params.force) {
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

/** Match the account in a resolved slot without letting optional name handling fail sign-in. */
export function isAuthProfileReconnect(
  incoming: AuthProfileCredential,
  previous: AuthProfileCredential | undefined,
  method: ReloginMethod,
): previous is AuthProfileCredential {
  if (!previous || previous.provider !== incoming.provider || previous.type !== incoming.type) {
    return false;
  }
  const matcher = sharedAccountMatcher(method);
  if (matcher) {
    try {
      return matcher(incoming, previous);
    } catch {
      return false;
    }
  }
  // A reused slot does not prove identity. A reference may resolve to a rotated secret.
  if (incoming.type === "api_key" && previous.type === "api_key") {
    return Boolean(incoming.key) && incoming.key === previous.key;
  }
  if (incoming.type === "token" && previous.type === "token") {
    return Boolean(incoming.token) && incoming.token === previous.token;
  }
  // OAuth account IDs are registration-scoped.
  return (
    incoming.type === "oauth" &&
    previous.type === "oauth" &&
    Boolean(incoming.accountId) &&
    incoming.accountId === previous.accountId &&
    incoming.issuer === previous.issuer &&
    incoming.clientId === previous.clientId
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
  const matcher = sharedAccountMatcher(params.method);
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
