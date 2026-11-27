import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { TurnGrant } from "../agents/admitted-run-operator-authority.types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { isSessionDeliveryGenerationRevokedError } from "../config/sessions/session-delivery-generation.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import {
  readSkillLibraryPromptListing,
  type SkillLibraryPromptListing,
} from "../config/sessions/skill-library-prompt-listing.js";
import { acquireTranscriptLease } from "../config/sessions/transcript-lease.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import { chatRef } from "../sessions/chat-ref.js";
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
import { SkillLibraryError } from "../skills/skill-library-error.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import {
  activateLibrarySelection,
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";

const active = new Map<string, Set<{ profileId: string; revoke: () => void }>>();
const SKILL_LIBRARY_TURN_REFUSAL =
  "Personal skill library authoring requires this turn's admitted grant. This turn has no human requester or authoring grant, so the call was not run.";

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

async function readCommittedPromptListing(
  params: {
    sessionKey: string;
    storedListing?: unknown;
    sessionEntry?: { skillLibraryPromptListing?: SkillLibraryPromptListing };
    listingStore?: { agentId: string; storePath: string };
  },
  assertCurrent: () => void,
): Promise<{ listing?: SkillLibraryPromptListing; hasRow: boolean }> {
  const passed = readSkillLibraryPromptListing(
    params.storedListing ?? params.sessionEntry?.skillLibraryPromptListing,
  );
  const store = params.listingStore;
  if (!store) {
    return { listing: passed, hasRow: false };
  }
  // The captured store is the physical owner. The session worker serves its
  // published row, including a retained fact, so this turn does not open the
  // agent database on the Gateway thread. A missing row has nothing published yet.
  const owned = await readSessionEntryReadOnlyInWorker(
    { ...store, sessionKey: params.sessionKey },
    assertCurrent,
  );
  // An explicitly selected store with no row cannot inherit a caller's old listing.
  return {
    listing: readSkillLibraryPromptListing(owned?.skillLibraryPromptListing),
    hasRow: owned !== undefined,
  };
}

async function commitSkillLibraryPromptListing(
  sessionKey: string,
  store: { agentId: string; storePath: string },
  listing: SkillLibraryPromptListing | undefined,
  assertCurrent: () => void,
  assertSourceCurrent: SessionSourceAssertion,
) {
  return await patchSessionEntryCore(
    {
      sessionKey,
      agentId: store.agentId,
      storePath: store.storePath,
    },
    (entry) => {
      const current = readSkillLibraryPromptListing(entry.skillLibraryPromptListing);
      if (listingsMatch(current, listing)) {
        return null;
      }
      return { skillLibraryPromptListing: listing };
    },
    { assertCommitAllowed: assertCurrent, workerGuard: { source: assertSourceCurrent } },
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

function grantsSkillAuthoring(options: SkillLibraryRequestOwner, grant: TurnGrant | undefined) {
  const client = options.client;
  return Boolean(
    grant?.skillAuthoring &&
    client?.authenticatedUserProfile &&
    !client.internal?.syntheticClient &&
    !client.internal?.agentRuntimeIdentity &&
    !client.internal?.senderAttribution &&
    !client.internal?.pluginRuntimeOwnerId &&
    !client.internal?.approvalRuntime &&
    !client.internal?.delegatedToolPolicyHandoffId,
  );
}

async function prepareGatewaySkillLibrarySession(
  options: SkillLibraryRequestOwner,
  grant: TurnGrant | undefined,
): Promise<PreparedSkillLibrarySession | undefined> {
  if (!grantsSkillAuthoring(options, grant)) {
    return undefined;
  }
  return prepareSkillLibrarySession(libraryAuthority(options));
}

export async function prepareGatewaySkillLibraryTurn(
  request: {
    owner: SkillLibraryRequestOwner;
    grant: TurnGrant | undefined;
    sessionKey: string;
    storedListing?: unknown;
    sessionEntry?: {
      sessionId?: string;
      lifecycleRevision?: string;
      skillLibraryPromptListing?: SkillLibraryPromptListing;
    };
    listingStore?: { agentId: string; storePath: string };
  },
  prepareSessionCreation: (prepared?: PreparedSkillLibrarySession) => Promise<void>,
  onAuthoring: () => void,
): Promise<SkillLibraryAuthoringCapability | undefined> {
  const prepared = await prepareGatewaySkillLibrarySession(request.owner, request.grant);
  await prepareSessionCreation(prepared);
  onAuthoring();
  return resolveGatewaySkillLibraryPromptGrant({ ...request, prepared });
}

/**
 * Keep `skill_library` in the session prompt whenever this conversation has a
 * recorded listing. A turn without an admitted authoring grant keeps that
 * definition and is refused at execution. An eligible turn refreshes it.
 */
export async function resolveGatewaySkillLibraryPromptGrant(params: {
  owner: SkillLibraryRequestOwner;
  sessionKey: string;
  grant: TurnGrant | undefined;
  prepared?: PreparedSkillLibrarySession;
  storedListing?: unknown;
  sessionEntry?: {
    sessionId?: string;
    lifecycleRevision?: string;
    skillLibraryPromptListing?: SkillLibraryPromptListing;
  };
  listingStore?: { agentId: string; storePath: string };
}): Promise<SkillLibraryAuthoringCapability | undefined> {
  const store = params.listingStore;
  let lease: Awaited<ReturnType<typeof acquireTranscriptLease>> | undefined;
  try {
    // A captured row pins its own transcript. Otherwise observe the selected
    // physical store, then let acquisition revalidate that row or its absence.
    const observed =
      store && !params.sessionEntry?.sessionId
        ? await readSessionEntryReadOnlyInWorker({ ...store, sessionKey: params.sessionKey })
        : undefined;
    const pin = params.sessionEntry?.sessionId ? params.sessionEntry : observed;
    lease = store
      ? await acquireTranscriptLease(chatRef({ ...store, sessionKey: params.sessionKey }), {
          sessionId: pin?.sessionId ?? null,
          lifecycleRevision: pin?.lifecycleRevision,
        })
      : undefined;
    const stored = await readCommittedPromptListing(params, lease?.assertCurrent ?? (() => {}));
    const storedListing = stored.listing;
    let next = storedListing;
    let live: SkillLibraryAuthoringCapability | undefined;
    if (grantsSkillAuthoring(params.owner, params.grant)) {
      live = await prepareGatewaySkillAuthoring(
        params.owner,
        params.sessionKey,
        params.grant,
        params.prepared,
      );
      if (live) {
        next = { multipleProfiles: live.multipleProfiles, defaultTarget: live.defaultTarget };
      } else {
        next = undefined;
      }
    }
    // The caller's entry is an immutable snapshot. Persistence returns the owner's
    // committed row, and this turn reads the listing from that result.
    let listingForTurn = next;
    if (store && stored.hasRow && !listingsMatch(storedListing, next)) {
      const saved = await commitSkillLibraryPromptListing(
        params.sessionKey,
        store,
        next,
        libraryAuthority(params.owner).assertCurrent,
        lease!.assertCurrent,
      );
      if (saved) {
        listingForTurn = readSkillLibraryPromptListing(saved.skillLibraryPromptListing);
      }
    }
    if (live) {
      lease?.assertCurrent();
      return live;
    }
    lease?.assertCurrent();
    return listingForTurn ? createRefusedSkillLibraryAuthoring(listingForTurn) : undefined;
  } catch (error) {
    if (isSessionDeliveryGenerationRevokedError(error)) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "This turn's session authority expired. Retry the request.",
        undefined,
        { cause: error },
      );
    }
    throw error;
  } finally {
    lease?.release();
  }
}

/** The turn's admitted grant mints the namespace; actions remain normal tool policy. */
export async function prepareGatewaySkillAuthoring(
  options: SkillLibraryRequestOwner,
  sessionKey: string,
  grant: TurnGrant | undefined,
  prepared?: PreparedSkillLibrarySession,
): Promise<SkillLibraryAuthoringCapability | undefined> {
  if (!grant || !grantsSkillAuthoring(options, grant)) {
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
      !caller.receiptAuthority
    ) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Personal authoring authority expired or this turn has mixed requesters. Send a fresh attributed message requesting the change.",
      );
    }
    caller.receiptAuthority();
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
      const binding = {
        profileId,
        revoke: () => {
          revoked = true;
        },
      };
      const grants = active.get(sessionKey) ?? new Set();
      grants.add(binding);
      active.set(sessionKey, grants);
      const stop = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
        if (closed !== owner) {
          return;
        }
        revoked = true;
        grants.delete(binding);
        if (!grants.size) {
          active.delete(sessionKey);
        }
        stop();
      });
    },
    assertWorkspaceCurrent() {
      assertCurrent();
      // Decided once at admission; a role change applies to the next turn.
      if (!grant.owner) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Workspace authoring requires administrator authority.",
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
