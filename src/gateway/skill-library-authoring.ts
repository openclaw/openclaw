import { isDeepStrictEqual } from "node:util";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  readSkillLibraryPromptListing,
  type SkillLibraryPromptListing,
} from "../config/sessions/skill-library-prompt-listing.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import {
  mergeSkillLibrarySupportFiles,
  type SkillLibraryAuthoringCapability,
} from "../skills/library/authoring.js";
import {
  prepareSkillLibrarySession,
  type PreparedSkillLibrarySession,
} from "../skills/library/selection.js";
import {
  listSkillLibrary,
  resolveSkillLibraryPresentation,
  readSkillLibrary,
  saveSkillLibrary,
  mutateSkillLibrary,
} from "../skills/library/service.js";
import { resolveSkillLibraryActorFromProfile } from "../skills/library/store.js";
import { SkillLibraryError } from "../skills/skill-library-error.js";
import {
  captureResidentUserProfileAccess,
  readResidentUserProfileId,
} from "../state/user-profile-list.js";
import {
  activateLibrarySelection,
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";

const active = new Map<string, Set<{ profileId: string; revoke: () => void }>>();
const SKILL_LIBRARY_TURN_REFUSAL =
  "Personal skill library authoring runs only when the person sends the request in this conversation. This turn has no human requester, so the call was not run.";
// Same-process settle reads this even when the loaded entry is stale. Absence means
// "not seen yet"; an explicit undefined means a human turn cleared the listing.
const promptListings = new Map<string, SkillLibraryPromptListing | undefined>();

function listingsMatch(
  left: SkillLibraryPromptListing | undefined,
  right: SkillLibraryPromptListing | undefined,
) {
  return (
    left?.multipleProfiles === right?.multipleProfiles &&
    left?.defaultTarget === right?.defaultTarget &&
    (left === undefined) === (right === undefined)
  );
}

function rememberPromptListing(sessionKey: string, listing: SkillLibraryPromptListing | undefined) {
  promptListings.set(sessionKey, listing);
}

function assignPromptListing(
  sessionEntry: { skillLibraryPromptListing?: SkillLibraryPromptListing } | undefined,
  listing: SkillLibraryPromptListing | undefined,
) {
  // Admitted entries are frozen. The process map and the session patch own the
  // listing; only a mutable caller snapshot can carry it on the object itself.
  if (
    !sessionEntry ||
    !Object.isExtensible(sessionEntry) ||
    listingsMatch(sessionEntry.skillLibraryPromptListing, listing)
  ) {
    return;
  }
  if (listing) {
    sessionEntry.skillLibraryPromptListing = listing;
  } else {
    delete sessionEntry.skillLibraryPromptListing;
  }
}

async function commitSkillLibraryPromptListing(
  sessionKey: string,
  store: { agentId?: string; storePath?: string },
  listing: SkillLibraryPromptListing | undefined,
) {
  if (!store.agentId && !store.storePath) {
    return;
  }
  await patchSessionEntryCore(
    {
      sessionKey,
      ...(store.agentId ? { agentId: store.agentId } : {}),
      ...(store.storePath ? { storePath: store.storePath } : {}),
    },
    (entry) => {
      const current = readSkillLibraryPromptListing(entry.skillLibraryPromptListing);
      if (listingsMatch(current, listing)) {
        return null;
      }
      return { skillLibraryPromptListing: listing };
    },
  );
}

function createRefusedSkillLibraryAuthoring(
  listing: SkillLibraryPromptListing,
): SkillLibraryAuthoringCapability {
  const refusal = new SkillLibraryError("AUTHORITY_EXPIRED", SKILL_LIBRARY_TURN_REFUSAL);
  return {
    target: "personal",
    defaultTarget: listing.defaultTarget,
    multipleProfiles: listing.multipleProfiles,
    turnRefusal: SKILL_LIBRARY_TURN_REFUSAL,
    assertWorkspaceCurrent() {
      throw refusal;
    },
    bind() {},
    invoke: async () => {
      throw refusal;
    },
  };
}

/** A mixed-person steer revokes mutation authority without changing the session's committed pins. */
export function invalidateSkillAuthoringForOtherRequester(
  sessionKey: string,
  profileId?: string,
): void {
  for (const grant of active.get(sessionKey) ?? []) {
    if (grant.profileId !== profileId) {
      const canonical = readResidentUserProfileId(grant.profileId);
      if (!profileId || !canonical || canonical !== readResidentUserProfileId(profileId)) {
        grant.revoke();
      }
    }
  }
}

function canPrepareSkillAuthoring(options: SkillLibraryRequestOwner, isHumanTurn: boolean) {
  const client = options.client;
  return Boolean(
    isHumanTurn &&
    client?.authenticatedUserProfile &&
    !client.internal?.syntheticClient &&
    !client.internal?.agentRuntimeIdentity &&
    !client.internal?.senderAttribution &&
    !client.internal?.pluginRuntimeOwnerId &&
    !client.internal?.approvalRuntime &&
    !client.internal?.cronRunContinuation &&
    !client.internal?.delegatedToolPolicyHandoffId,
  );
}

async function prepareGatewaySkillLibrarySession(
  options: SkillLibraryRequestOwner,
  isHumanTurn: boolean,
): Promise<PreparedSkillLibrarySession | undefined> {
  if (!canPrepareSkillAuthoring(options, isHumanTurn)) {
    return undefined;
  }
  const client = options.client;
  const authority = libraryAuthority(options);
  const scopes = [...authority.scopes];
  return prepareSkillLibrarySession({
    ...authority,
    assertCurrent() {
      authority.assertCurrent();
      if (
        options.client !== client ||
        client?.authenticatedUserProfile?.profileId !== authority.profileId ||
        !isDeepStrictEqual(client?.connect.scopes ?? [], scopes)
      ) {
        throw new SkillLibraryError("AUTHORITY_EXPIRED", "Skill library requester changed. Retry.");
      }
    },
  });
}

export async function prepareGatewaySkillLibraryTurn(
  request: {
    owner: SkillLibraryRequestOwner;
    isHumanTurn: boolean;
    sessionKey: string;
    storedListing?: unknown;
    sessionEntry?: { skillLibraryPromptListing?: SkillLibraryPromptListing };
    listingStore?: { agentId?: string; storePath?: string };
  },
  prepareSessionCreation: (prepared?: PreparedSkillLibrarySession) => Promise<void>,
  onAuthoring: () => void,
): Promise<SkillLibraryAuthoringCapability | undefined> {
  const prepared = request.isHumanTurn
    ? await prepareGatewaySkillLibrarySession(request.owner, true)
    : undefined;
  await prepareSessionCreation(prepared);
  onAuthoring();
  return resolveGatewaySkillLibraryPromptGrant({ ...request, prepared });
}

/**
 * Keep `skill_library` in the session prompt whenever this conversation has a
 * recorded listing. A turn without a human requester keeps that definition and
 * is refused at execution. Only an eligible human turn refreshes the listing.
 */
export async function resolveGatewaySkillLibraryPromptGrant(params: {
  owner: SkillLibraryRequestOwner;
  sessionKey: string;
  isHumanTurn: boolean;
  prepared?: PreparedSkillLibrarySession;
  storedListing?: unknown;
  sessionEntry?: { skillLibraryPromptListing?: SkillLibraryPromptListing };
  listingStore?: { agentId?: string; storePath?: string };
}): Promise<SkillLibraryAuthoringCapability | undefined> {
  const storedListing = params.storedListing ?? params.sessionEntry?.skillLibraryPromptListing;
  if (!promptListings.has(params.sessionKey)) {
    rememberPromptListing(params.sessionKey, readSkillLibraryPromptListing(storedListing));
  }
  const previous = promptListings.get(params.sessionKey);
  let next = previous;
  let live: SkillLibraryAuthoringCapability | undefined;
  if (params.isHumanTurn) {
    live = await prepareGatewaySkillAuthoring(
      params.owner,
      params.sessionKey,
      true,
      params.prepared,
    );
    if (live) {
      next = { multipleProfiles: live.multipleProfiles, defaultTarget: live.defaultTarget };
    } else if (canPrepareSkillAuthoring(params.owner, true)) {
      next = undefined;
    }
  }
  if (!listingsMatch(previous, next)) {
    rememberPromptListing(params.sessionKey, next);
  }
  assignPromptListing(params.sessionEntry, next);
  if (params.listingStore && !listingsMatch(readSkillLibraryPromptListing(storedListing), next)) {
    await commitSkillLibraryPromptListing(params.sessionKey, params.listingStore, next);
  }
  if (live) {
    return live;
  }
  const listing = promptListings.get(params.sessionKey);
  return listing ? createRefusedSkillLibraryAuthoring(listing) : undefined;
}

/** Only ordinary attributed human ingress may mint a namespace; actions remain normal tool policy. */
export async function prepareGatewaySkillAuthoring(
  options: SkillLibraryRequestOwner,
  sessionKey: string,
  isHumanTurn: boolean,
  prepared?: PreparedSkillLibrarySession,
): Promise<SkillLibraryAuthoringCapability | undefined> {
  if (!canPrepareSkillAuthoring(options, isHumanTurn)) {
    return undefined;
  }
  const authority = libraryAuthority(options);
  const library = prepared?.presentation ?? (await resolveSkillLibraryPresentation(authority));
  prepared?.assertCurrent();
  authority.assertCurrent();
  if (!library.profileId || library.defaultTarget === "unavailable") {
    return undefined;
  }
  const profileId = library.profileId;
  invalidateSkillAuthoringForOtherRequester(sessionKey, profileId);
  let bound: AdmittedRunContext | undefined;
  let revoked = false;
  let owner: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
  const assertCurrent = () => {
    authority.assertCurrent();
    const caller = getGatewayToolCallerIdentity();
    if (
      revoked ||
      !bound ||
      !owner ||
      getAdmittedRunDelegatedAuthority(bound) !== owner ||
      caller?.operationalRunInstance !== bound.operationalRunInstance ||
      !caller.receiptAuthority ||
      caller.receiptAuthority() === false
    ) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Personal authoring authority expired or this turn has mixed requesters. Send a fresh attributed message requesting the change.",
      );
    }
  };
  const currentAuthority = { ...authority, assertCurrent, namespace: "personal" as const };
  return {
    target: "personal",
    defaultTarget: library.defaultTarget,
    multipleProfiles: library.multipleProfiles,
    bind(context) {
      if (bound) {
        if (context !== bound) {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Personal authoring cannot move to a replacement run. Send a fresh message.",
          );
        }
        return;
      }
      bound = context;
      owner = getAdmittedRunDelegatedAuthority(context);
      if (!owner) {
        throw new SkillLibraryError(
          "AUTHORITY_EXPIRED",
          "Personal authoring run was not admitted.",
        );
      }
      const grant = {
        profileId,
        revoke: () => {
          revoked = true;
        },
      };
      const grants = active.get(sessionKey) ?? new Set();
      grants.add(grant);
      active.set(sessionKey, grants);
      const stop = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
        if (closed !== owner) {
          return;
        }
        revoked = true;
        grants.delete(grant);
        if (!grants.size) {
          active.delete(sessionKey);
        }
        stop();
      });
    },
    assertWorkspaceCurrent() {
      assertCurrent();
      const profile = captureResidentUserProfileAccess(profileId).readCurrentFacts();
      if (
        !resolveSkillLibraryActorFromProfile(authority, authority.getConfig(), {
          id: profile.profileId,
          role: profile.assignedRole,
          githubLogin: profile.githubLogin,
        }).admin
      ) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Workspace authoring requires current administrator authority.",
        );
      }
    },
    async invoke(input) {
      assertCurrent();
      if (input.action === "list") {
        return listSkillLibrary(currentAuthority);
      }
      if (input.action === "read" || input.action === "activate") {
        if (!input.skillId) {
          throw new SkillLibraryError("INVALID_BUNDLE", "Choose skill_id from list.");
        }
        if (input.action === "read") {
          return readSkillLibrary(currentAuthority, input.skillId, input.revision);
        }
        return activateLibrarySelection(
          { ...options, sessionMutationCommitGuard: assertCurrent },
          { sessionKey, action: "attach", skillId: input.skillId, revision: input.revision },
        );
      }
      if (input.action !== "create" && (!input.skillId || !input.expectedRevision)) {
        throw new SkillLibraryError(
          "INVALID_BUNDLE",
          "Read the skill first; supply skill_id and expected_revision from that read.",
        );
      }
      if (input.action === "create" || input.action === "update") {
        const current =
          input.action === "update"
            ? await readSkillLibrary(currentAuthority, input.skillId!, input.expectedRevision)
            : undefined;
        const slug = input.slug ?? current?.entry.slug;
        const content = input.content ?? current?.content;
        if (!slug || !content) {
          throw new SkillLibraryError(
            "INVALID_BUNDLE",
            "Creating a skill requires name (the human slug) and complete proposal_content.",
          );
        }
        return saveSkillLibrary(currentAuthority, {
          slug,
          content,
          files: mergeSkillLibrarySupportFiles(
            current?.files ?? [],
            input.files,
            input.deleteFiles,
          ),
          skillId: input.action === "update" ? input.skillId : undefined,
          expectedRevision: input.action === "create" ? null : input.expectedRevision!,
        });
      }
      return mutateSkillLibrary(currentAuthority, {
        action: input.action,
        skillId: input.skillId!,
        expectedRevision: input.expectedRevision!,
        revision: input.revision,
      });
    },
  };
}
