import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionParticipant } from "../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { TranscriptSenderIdentity } from "../chat/sender-identity.js";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor as StoredSessionActor,
} from "../config/sessions/session-entry-provenance.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import type {
  UserProfileCatalogIdentityInput,
  UserProfileCatalogIdentityRead,
} from "../state/user-profile-catalog-identity.read.js";
import {
  captureUserProfileAuthorityRead,
  readUserProfileVersion,
} from "../state/user-profile-events.js";
import { selectStoredGitHubIdentities } from "../state/user-profile-github-identity.js";
import { getUserProfileDisplays } from "../state/user-profile-list.js";
import { getUserProfileDisplay, UserProfileNotFoundError } from "../state/user-profiles.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { projectSessionActor, projectSessionParticipant } from "./session-identity-projection.js";

type CatalogSourceIdentity = { pluginId: string; sourceDomain: string };

async function prepareIdentityFacts(input: UserProfileCatalogIdentityInput) {
  const context = captureOpenClawStateReadWorkerContext();
  const identity = context.admission.identity;
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const version = readUserProfileVersion();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "userProfiles.catalogIdentity", input },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (reply && (!reply.ok || reply.type !== "userProfiles.catalogIdentity")) {
    throw new Error("Session catalog identity reader returned an unexpected result");
  }
  const result: UserProfileCatalogIdentityRead = reply?.result ?? {
    profiles: new Map(),
    accounts: new Map(),
    owners: new Map(),
  };
  const isCurrent = authority.bind([
    ...result.profiles.keys(),
    ...[...result.profiles.values()].flatMap((profile) =>
      profile.ok ? [profile.facts.profileId] : [],
    ),
  ]);
  const assertCurrent = () => {
    if (identity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(
        context.admission.databasePath,
        identity.key,
        identity.birthtime,
      );
    }
    if (!isCurrent?.() || readUserProfileVersion() !== version) {
      throw new Error(
        "Session catalog identities changed while preparing the page. Retry the request.",
      );
    }
  };
  assertCurrent();
  return {
    ...result,
    assertCurrent,
    readProfile(id: string) {
      assertCurrent();
      const profile = result.profiles.get(id);
      if (profile && !profile.ok) {
        const error = new Error(profile.message);
        retainOpenClawStateWorkerErrorPayload(error, profile.error);
        throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
      }
      return profile?.facts ?? { profileId: id, profile: undefined, github: undefined };
    },
  };
}

function sourceLabel(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? truncateUtf16Safe(redactToolPayloadText(text), 200) : undefined;
}

function verifiedGitHubIdentities(profileIds?: readonly string[]) {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
    tableExists(db, "user_profile_identities")
      ? selectStoredGitHubIdentities(db, profileIds)
      : undefined,
  );
}

function readSourceProfileFacts(id: string) {
  let profile: ReturnType<typeof getUserProfileDisplay> | undefined;
  try {
    profile = getUserProfileDisplay(id);
  } catch (error) {
    if (!(error instanceof UserProfileNotFoundError)) {
      throw error;
    }
  }
  const profileId = profile?.id ?? id;
  const github = verifiedGitHubIdentities([profileId])?.get(profileId)?.primary;
  return { profileId, profile, github };
}

type SourceParticipantParams = CatalogSourceIdentity & {
  identity: TranscriptSenderIdentity;
  label?: string;
};

function projectSourceParticipant(
  params: SourceParticipantParams,
  resolveProfile: typeof readSourceProfileFacts,
): SessionParticipant {
  const { identity } = params;
  if (identity.type !== "profile") {
    const label = sourceLabel(params.label);
    return { identity, ...(label ? { label } : {}) };
  }
  const { profileId, profile, github } = resolveProfile(identity.id);
  const label = sourceLabel(profile?.displayName ?? github?.login ?? params.label);
  return {
    identity: {
      type: "remote",
      pluginId: params.pluginId,
      domain: params.sourceDomain,
      idKind: github ? "github-account" : "profile",
      id: github ? String(github.accountId) : profileId,
    },
    ...(label ? { label } : {}),
  };
}

/** Prepare one sender cohort off-thread; synchronous projection never opens profile storage. */
export async function prepareSessionCatalogSourceParticipantProjector(
  identities: readonly TranscriptSenderIdentity[],
) {
  const ids = [
    ...new Set(
      identities.flatMap((identity) => (identity.type === "profile" ? [identity.id] : [])),
    ),
  ];
  const prepared = ids.length
    ? await prepareIdentityFacts({ kind: "source", profileIds: ids })
    : undefined;
  return {
    assertCurrent: () => prepared?.assertCurrent(),
    project: (params: SourceParticipantParams): SessionParticipant =>
      projectSourceParticipant(params, (id) => {
        if (!prepared) {
          throw new Error("Session catalog sender was not prepared");
        }
        return prepared.readProfile(id);
      }),
  };
}

function projectSourceActor(
  params: CatalogSourceIdentity & { actor: StoredSessionActor | undefined },
  resolveProfile: typeof readSourceProfileFacts,
): SessionCreatedActor | undefined {
  const { actor } = params;
  if (!actor) {
    return undefined;
  }
  const profileId = sessionCreatorProfileId(actor);
  const participant = profileId
    ? projectSourceParticipant(
        {
          ...params,
          identity: { type: "profile", id: profileId },
          label: actor.label,
        },
        resolveProfile,
      )
    : undefined;
  const label = sourceLabel(actor.label);
  return {
    type: actor.type,
    ...(actor.id ? { id: participant?.identity.id ?? actor.id } : {}),
    ...(label ? { label } : {}),
    ...participant,
  };
}

/** Prepare portable creator claims for one synchronous page; claims never grant access. */
export function createSessionCatalogSourceActorProjector(
  params: CatalogSourceIdentity & { actors: readonly (StoredSessionActor | undefined)[] },
): (actor: StoredSessionActor | undefined) => SessionCreatedActor | undefined {
  const ids = [
    ...new Set(
      params.actors.flatMap((actor) => {
        const id = sessionCreatorProfileId(actor);
        return id ? [id] : [];
      }),
    ),
  ];
  let facts: Map<string, ReturnType<typeof readSourceProfileFacts>> | undefined;
  let attempted = false;
  return (actor) =>
    projectSourceActor({ ...params, actor }, (requestedId) => {
      if (!attempted) {
        attempted = true;
        try {
          const profiles = getUserProfileDisplays(ids);
          const canonicalIds = [...new Set(ids.map((id) => profiles.get(id)?.id ?? id))];
          const identities = verifiedGitHubIdentities(canonicalIds);
          facts = new Map(
            ids.map((id) => {
              const profile = profiles.get(id);
              const profileId = profile?.id ?? id;
              return [id, { profileId, profile, github: identities?.get(profileId)?.primary }];
            }),
          );
        } catch (error) {
          // Corruption has already reached the database lifecycle owner; never retry a poisoned read.
          if (isSqliteCorruptionError(error)) {
            throw error;
          }
          // Nonterminal conversion/parse failures replay in the original scalar and actor-label order.
        }
      }
      return facts?.get(requestedId) ?? readSourceProfileFacts(requestedId);
    });
}

/** Prepare portable creator claims at the profile reader before synchronous page disclosure. */
export async function prepareSessionCatalogSourceActorProjector(
  params: CatalogSourceIdentity & { actors: readonly (StoredSessionActor | undefined)[] },
) {
  const ids = [
    ...new Set(
      params.actors.flatMap((actor) => {
        const id = sessionCreatorProfileId(actor);
        return id ? [id] : [];
      }),
    ),
  ];
  const prepared = ids.length
    ? await prepareIdentityFacts({ kind: "source", profileIds: ids })
    : undefined;
  return (actor: StoredSessionActor | undefined) =>
    projectSourceActor({ ...params, actor }, (id) => {
      if (!prepared) {
        throw new Error("Session catalog creator was not prepared");
      }
      return prepared.readProfile(id);
    });
}

/** Link only the selected page's portable claims; these display facts never grant access. */
export async function prepareSessionCatalogGitHubLinker(params: {
  participants: readonly SessionParticipant[];
  owners?: readonly string[];
}) {
  const accountIds = [
    ...new Set(
      params.participants.flatMap(({ identity }) =>
        identity.type === "remote" && identity.idKind === "github-account" ? [identity.id] : [],
      ),
    ),
  ];
  if (accountIds.length === 0 && !params.owners?.length) {
    return {
      assertCurrent(this: void) {},
      linkParticipant(this: void, participant: SessionParticipant): SessionParticipant {
        return participant;
      },
      resolveOwner(this: void, _owner: string): SessionCreatedActor | undefined {
        return undefined;
      },
    };
  }
  const prepared = await prepareIdentityFacts({
    kind: "link",
    accountIds,
    owners: params.owners ?? [],
  });
  const profiles: Parameters<typeof projectSessionParticipant>[1] = new Map();
  const prepareDisplay = (id: string) => {
    if (!profiles.has(id)) {
      const display = resolveCurrentUserProfileDisplay(id, () => prepared.readProfile(id).profile);
      profiles.set(id, display.kind === "resolved" ? display : undefined);
    }
  };
  return {
    assertCurrent: prepared.assertCurrent,
    linkParticipant(this: void, participant: SessionParticipant): SessionParticipant {
      prepared.assertCurrent();
      const { identity } = participant;
      const id =
        identity.type === "remote" && identity.idKind === "github-account"
          ? prepared.accounts.get(identity.id)
          : undefined;
      if (!id) {
        return participant;
      }
      prepareDisplay(id);
      return projectSessionParticipant({ type: "profile", id }, profiles);
    },
    resolveOwner(this: void, owner: string): SessionCreatedActor | undefined {
      prepared.assertCurrent();
      const id = prepared.owners.get(owner);
      const profile = id ? prepared.readProfile(id).profile : undefined;
      if (!profile) {
        return undefined;
      }
      prepareDisplay(id!);
      profiles.set(profile.id, profiles.get(id!));
      return projectSessionActor({ type: "human", id: profile.id }, profiles);
    },
  };
}

/** Snapshot attribution links once per catalog page; claims never grant access. */
export function createSessionCatalogGitHubLinker() {
  const profilesByAccountId = new Map<string, string>();
  const profilesByLogin = new Map<string, string>();
  const profiles: Parameters<typeof projectSessionParticipant>[1] = new Map();
  for (const [profileId, { accounts }] of verifiedGitHubIdentities() ?? []) {
    for (const github of accounts) {
      const accountId = String(github.accountId);
      const login = github.login.toLowerCase();
      if (!profilesByAccountId.has(accountId)) {
        profilesByAccountId.set(accountId, profileId);
      }
      if (!profilesByLogin.has(login)) {
        profilesByLogin.set(login, profileId);
      }
    }
  }
  return {
    linkParticipant(this: void, participant: SessionParticipant): SessionParticipant {
      const { identity } = participant;
      if (identity.type !== "remote" || identity.idKind !== "github-account") {
        return participant;
      }
      const profileId = profilesByAccountId.get(identity.id);
      return profileId
        ? projectSessionParticipant({ type: "profile", id: profileId }, profiles)
        : participant;
    },
    resolveOwner(this: void, owner: string): SessionCreatedActor | undefined {
      const profileId = owner.startsWith("profile:")
        ? owner.slice("profile:".length)
        : owner.startsWith("github:")
          ? profilesByLogin.get(owner.slice("github:".length).toLowerCase())
          : undefined;
      if (!profileId) {
        return undefined;
      }
      try {
        const profile = getUserProfileDisplay(profileId);
        return projectSessionActor({ type: "human", id: profile.id }, profiles);
      } catch (error) {
        if (!(error instanceof UserProfileNotFoundError)) {
          throw error;
        }
        return undefined;
      }
    },
  };
}
