import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionParticipant } from "../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { TranscriptSenderIdentity } from "../chat/sender-identity.js";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor as StoredSessionActor,
} from "../config/sessions/session-entry-provenance.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { selectStoredGitHubIdentities } from "../state/user-profile-github-identity.js";
import { getUserProfileDisplay, UserProfileNotFoundError } from "../state/user-profiles.js";
import { projectSessionActor, projectSessionParticipant } from "./session-identity-projection.js";

type CatalogSourceIdentity = { pluginId: string; sourceDomain: string };

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
  const github = verifiedGitHubIdentities([profileId])?.get(profileId);
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

/** Converts local attribution into a portable claim, never a remote access grant. */
function projectSessionCatalogSourceParticipant(
  params: SourceParticipantParams,
): SessionParticipant {
  return projectSourceParticipant(params, readSourceProfileFacts);
}

/** A synchronous page reuses first-read display facts; later pages read fresh state. */
export function createSessionCatalogSourceParticipantProjector() {
  const profiles = new Map<string, ReturnType<typeof readSourceProfileFacts>>();
  return (params: SourceParticipantParams): SessionParticipant =>
    projectSourceParticipant(params, (id) => {
      let facts = profiles.get(id);
      if (!facts) {
        facts = readSourceProfileFacts(id);
        profiles.set(id, facts);
      }
      return facts;
    });
}

/** Only source-qualified creators may resolve a local profile before publication. */
export function projectSessionCatalogSourceActor(
  params: CatalogSourceIdentity & { actor: StoredSessionActor | undefined },
): SessionCreatedActor | undefined {
  const { actor } = params;
  if (!actor) {
    return undefined;
  }
  const profileId = sessionCreatorProfileId(actor);
  const participant = profileId
    ? projectSessionCatalogSourceParticipant({
        ...params,
        identity: { type: "profile", id: profileId },
        label: actor.label,
      })
    : undefined;
  const label = sourceLabel(actor.label);
  return {
    type: actor.type,
    ...(actor.id ? { id: participant?.identity.id ?? actor.id } : {}),
    ...(label ? { label } : {}),
    ...participant,
  };
}

/** Snapshot attribution links once per catalog page; claims never grant access. */
export function createSessionCatalogGitHubLinker() {
  const profilesByAccountId = new Map<string, string>();
  const profilesByLogin = new Map<string, string>();
  const profiles: Parameters<typeof projectSessionParticipant>[1] = new Map();
  for (const [profileId, github] of verifiedGitHubIdentities() ?? []) {
    const accountId = String(github.accountId);
    const login = github.login.toLowerCase();
    if (!profilesByAccountId.has(accountId)) {
      profilesByAccountId.set(accountId, profileId);
    }
    if (!profilesByLogin.has(login)) {
      profilesByLogin.set(login, profileId);
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
