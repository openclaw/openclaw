import {
  ErrorCodes,
  errorShape,
  validateSessionMemberAddParams,
  validateSessionMemberRemoveParams,
  validateSessionMembersListParams,
  validateSessionVisibilitySetParams,
  validateSessionPublicShareSetParams,
  type SessionPublicShare,
  type SessionMember,
  type SessionMemberEvidence,
  type SessionSharingEvent,
  type SessionSharingEvidenceEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { addSessionMember, removeSessionMember } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import type { SessionMember as StoredSessionMember } from "../../config/sessions/session-sharing-store.kernel.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listProfiles } from "../../state/user-profiles.js";
import {
  loadPublicSessionShareTokenCodec,
  type PublicSessionShareTokenCodec,
} from "../control-ui-public-session-token.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import { projectSessionActor } from "../session-identity-projection.js";
import { prepareSessionPublicShareGrant } from "../session-publication-grant.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  allowedSessionVisibilities,
  invalidateSessionSharingSnapshot,
  isSessionVisibilityAllowed,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { measureSessionCollaborationPhase } from "./sessions-collaboration-diagnostics.js";
import { prepareManagedSessionAccess, sharingExpectedEntry } from "./sessions-sharing-authority.js";
import { knownSessionIdentities, type SharingActorFacts } from "./sessions-sharing-identities.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

function runExclusiveSharingMutation<T>(
  target: SessionSharingTarget,
  storePath: string,
  run: () => Promise<T>,
): Promise<T> {
  // Sharing and lifecycle mutations share one exact-row fence so authorization
  // cannot change between archive's stop and commit boundaries.
  return runExclusiveSessionLifecycleMutation("sharing", {
    scope: storePath,
    identities: [target.canonicalKey, target.storeKey, ...target.storeKeys, target.entry.sessionId],
    run,
  });
}

const UNKNOWN_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unknown";
const UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unattributed";
const LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS = new Set(["local-operator", "operator.admin"]);

function actorIdentity(client: GatewayClient | null): SharingActorFacts {
  const principal = gatewayClientSessionCreator(client);
  if (principal) {
    return { state: "present", actor: principal };
  }
  return getGatewayLocalUserIngress(client)?.facts.invoker?.state === "unknown"
    ? { state: "unknown" }
    : { state: "absent" };
}

function sharingActorStorageRef(facts: SharingActorFacts): string {
  return facts.state === "present"
    ? facts.actor.id
    : facts.state === "unknown"
      ? UNKNOWN_SHARING_ACTOR_STORAGE_REF
      : UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF;
}

function projectSessionMemberEvidence(member: StoredSessionMember): SessionMemberEvidence {
  // Sentinel ids satisfy the existing non-null storage contract only. Project
  // actor evidence here so persistence markers never become protocol identities.
  const common = { identityId: member.identityId, addedAt: member.addedAt };
  if (member.addedBy === UNKNOWN_SHARING_ACTOR_STORAGE_REF) {
    return { ...common, addedByState: "unknown" };
  }
  if (
    member.addedBy === UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF ||
    LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS.has(member.addedBy)
  ) {
    // Beta builds stored fabricated operator ids before actor evidence became
    // tri-state. Discard those unshipped values instead of presenting principals.
    return common;
  }
  return { ...common, addedBy: member.addedBy };
}

function projectLegacySessionMember(member: SessionMemberEvidence): SessionMember | null {
  if (!member.addedBy) {
    return null;
  }
  return {
    identityId: member.identityId,
    addedBy: member.addedBy,
    addedAt: member.addedAt,
  };
}

function projectPublicSessionShare(params: {
  agentId: string;
  sessionKey: string;
  grant: NonNullable<ReturnType<typeof resolveSessionPublicShare>>;
  codec: PublicSessionShareTokenCodec;
}): SessionPublicShare {
  return {
    token: params.codec.mint({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.grant.sessionId,
      shareId: params.grant.id,
    }),
    createdAt: params.grant.createdAt,
  };
}

function publishSharingChange(params: {
  context: GatewayRequestContext;
  actor: SharingActorFacts;
  event: Omit<SessionSharingEvidenceEvent, "actorState">;
}): void {
  bumpGatewayAccessRevision();
  invalidateSessionSharingSnapshot(params.event.sessionKey);
  const eventOptions = {
    sessionKeys: [params.event.sessionKey],
  };
  if (params.actor.state === "present") {
    const event: SessionSharingEvent = { ...params.event, actor: params.actor.actor };
    params.context.broadcast("session.sharing", event, eventOptions);
  } else {
    const event: SessionSharingEvidenceEvent = {
      ...params.event,
      ...(params.actor.state === "unknown" ? { actorState: "unknown" } : {}),
    };
    params.context.broadcast("session.sharing.evidence", event, eventOptions);
  }
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.event.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}

function defineManagedSessionHandler<T extends { sessionKey: string; agentId?: string }>(
  method: string,
  validate: Validator<T>,
  handler: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: T },
    access: NonNullable<Awaited<ReturnType<typeof prepareManagedSessionAccess>>>,
  ) => Promise<void>,
  operation: "read" | "mutation" = "mutation",
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(method, validate, async (options) => {
    using access = await prepareManagedSessionAccess({
      ...options,
      sessionKey: options.params.sessionKey,
      agentId: options.params.agentId,
      operation,
    });
    if (access) {
      await handler(options, access);
    }
  });
}

function createSessionMembersListHandler(
  method: "session.members.list" | "session.members.listEvidence",
): GatewayRequestHandlers[string] {
  const evidenceAware = method === "session.members.listEvidence";
  return defineManagedSessionHandler(
    method,
    validateSessionMembersListParams,
    async ({ respond, client, context }, access) => {
      const managed = access.target;
      const projection = requireSessionRowProjection(context);
      await projection.withSelectionPreparation(async () => {
        const profiles = await measureSessionCollaborationPhase(`${method}.profiles`, () =>
          listProfiles(),
        );
        do {
          await measureSessionCollaborationPhase(`${method}.projection`, () =>
            Promise.resolve(projection.prepareSelection()),
          );
        } while (projection.needsSelectionPreparation());
        let tokenCodec = resolveSessionPublicShare(managed.entry)
          ? await loadPublicSessionShareTokenCodec()
          : undefined;
        const readEvidence = async () => {
          const evidence = await measureSessionCollaborationPhase(`${method}.evidence`, () =>
            readSessionMembersInWorker({
              agentId: managed.agentId,
              sessionKey: managed.storeKey,
              storePath: managed.storePath,
            }),
          );
          access.assertCurrent();
          if (!evidence.entry) {
            throw new Error("session changed before sharing read");
          }
          return { entry: evidence.entry, members: evidence.members };
        };
        let evidence = await readEvidence();
        if (resolveSessionPublicShare(evidence.entry) && !tokenCodec) {
          const prepared = loadPublicSessionShareTokenCodec();
          if (prepared instanceof Promise) {
            tokenCodec = await prepared;
            // Foreign publication can reveal a cold codec after discovery. Its wait
            // ends the read phase; authorize only the fresh row from the same target.
            evidence = await readEvidence();
          } else {
            tokenCodec = prepared;
          }
        }
        const { entry, members: storedMembers } = evidence;
        const publicShareGrant = resolveSessionPublicShare(entry);
        const currentCfg = context.getRuntimeConfig();
        const { target, role } = access.current(entry);
        const evidenceMembers = storedMembers.map(projectSessionMemberEvidence);
        const actor = actorIdentity(client);
        const members = evidenceAware
          ? evidenceMembers
          : evidenceMembers.map(projectLegacySessionMember);
        if (!evidenceAware && members.some((member) => member === null)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "session membership includes actor evidence this client cannot represent",
              {
                details: {
                  code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
                  recommendedMethod: "session.members.listEvidence",
                },
              },
            ),
          );
          return;
        }
        const projectedMembers = members.filter((member) => member !== null);
        const identities = knownSessionIdentities({
          creators: projection.listCreatedActors(),
          actor,
          profiles,
        });
        for (const member of projectedMembers) {
          if (!identities.some((identity) => identity.id === member.identityId)) {
            identities.push({ type: "human", id: member.identityId });
          }
        }
        identities.sort(
          (left, right) =>
            (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
            left.id.localeCompare(right.id),
        );
        // Persisted provenance deliberately has no current profile label or avatar.
        // Project it at the same display boundary as session rows; never change the access identity.
        const storedOwner = entry.createdActor;
        const owner = sessionCreatorProfileId(storedOwner)
          ? projectSessionActor(storedOwner, new Map(), currentCfg)
          : storedOwner
            ? { type: storedOwner.type, id: storedOwner.id, label: storedOwner.label }
            : undefined;
        const publicShare =
          publicShareGrant?.sessionId === target.entry.sessionId && tokenCodec
            ? projectPublicSessionShare({
                agentId: target.agentId,
                sessionKey: target.canonicalKey,
                grant: publicShareGrant,
                codec: tokenCodec,
              })
            : undefined;
        respond(
          true,
          {
            sessionKey: target.canonicalKey,
            ...(publicShare ? { publicShare } : {}),
            ...(owner?.id ? { owner } : {}),
            members: projectedMembers,
            identities,
            role,
            allowedVisibilities: allowedSessionVisibilities(currentCfg),
          },
          undefined,
        );
      });
    },
    "read",
  );
}

function createSessionMemberMutationHandler(
  action: "add" | "remove",
): GatewayRequestHandlers[string] {
  return defineManagedSessionHandler(
    `session.members.${action}`,
    action === "add" ? validateSessionMemberAddParams : validateSessionMemberRemoveParams,
    async ({ params, respond, client, context }, access) => {
      const managed = access.target;
      let addActor: SharingActorFacts | undefined;
      if (action === "add") {
        const projection = requireSessionRowProjection(context);
        const profiles = await listProfiles();
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
        access.assertCurrent();
        addActor = actorIdentity(client);
        const known = knownSessionIdentities({
          creators: projection.listCreatedActors(),
          actor: addActor,
          profiles,
        });
        if (!known.some((identity) => identity.id === params.identityId)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown identity"));
          return;
        }
      }
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const { target: current } = access.current();
        const scope = {
          agentId: current.agentId,
          sessionKey: current.storeKey,
          storePath: current.storePath,
        };
        let now: number;
        let actor: SharingActorFacts;
        if (addActor) {
          now = Date.now();
          actor = addActor;
          const added = await addSessionMember(
            scope,
            {
              identityId: params.identityId,
              addedBy: sharingActorStorageRef(actor),
              addedAt: now,
              expectedSessionId: current.entry.sessionId,
              expectedEntry: sharingExpectedEntry(current),
            },
            access.assertCurrent,
          );
          if (!added.inserted) {
            return;
          }
        } else {
          const removed = await removeSessionMember(
            scope,
            params.identityId,
            undefined,
            current.entry.sessionId,
            access.assertCurrent,
            sharingExpectedEntry(current),
          );
          if (!removed) {
            return;
          }
          now = Date.now();
          actor = actorIdentity(client);
        }
        publishSharingChange({
          context,
          actor,
          event: {
            action: action === "add" ? "member-added" : "member-removed",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
            identityId: params.identityId,
            ts: now,
          },
        });
      });
      respond(
        true,
        { ok: true, sessionKey: managed.canonicalKey, identityId: params.identityId },
        undefined,
      );
    },
  );
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.publicShare.set": defineManagedSessionHandler(
    "session.publicShare.set",
    validateSessionPublicShareSetParams,
    async ({ params, respond, context }, access) => {
      const managed = access.target;
      if (managed.entry.incognito || isIncognitoSessionKey(managed.canonicalKey)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Incognito sessions cannot be published."),
        );
        return;
      }
      if (managed.entry.sessionId !== params.expectedSessionId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session changed; reopen sharing before publishing.",
          ),
        );
        return;
      }
      let publicShare: SessionPublicShare | undefined;
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const tokenCodec = params.enabled ? await loadPublicSessionShareTokenCodec() : undefined;
        const { target: current } = access.current();
        let changed = false;
        let inspected = false;
        await patchSessionEntryCore(
          {
            agentId: current.agentId,
            sessionKey: current.storeKey,
            storePath: current.storePath,
          },
          (entry) => {
            inspected = true;
            if (entry.sessionId !== params.expectedSessionId) {
              throw new Error("session changed before sharing mutation");
            }
            if (entry.incognito || isIncognitoSessionKey(current.canonicalKey)) {
              throw new Error("Incognito sessions cannot be published.");
            }
            access.assertEntryManageable(entry);
            const previous = resolveSessionPublicShare(entry);
            const publicShareGrant = params.enabled
              ? prepareSessionPublicShareGrant(entry, current.canonicalKey)
              : undefined;
            publicShare =
              publicShareGrant && tokenCodec
                ? projectPublicSessionShare({
                    agentId: current.agentId,
                    sessionKey: current.canonicalKey,
                    grant: publicShareGrant,
                    codec: tokenCodec,
                  })
                : undefined;
            changed = publicShareGrant?.id !== previous?.id;
            return changed ? { publicShare: publicShareGrant } : null;
          },
          {
            // Entry patches await preparation before committing. Recheck current
            // sharing authority on the synchronous commit edge, after that await.
            assertCommitAllowed: access.assertCurrent,
          },
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (changed) {
          emitSessionsChanged(context, {
            reason: "sharing",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
          });
        }
      });
      respond(
        true,
        {
          ok: true,
          sessionKey: managed.canonicalKey,
          ...(publicShare ? { publicShare } : {}),
        },
        undefined,
      );
    },
  ),
  "session.visibility.set": defineManagedSessionHandler(
    "session.visibility.set",
    validateSessionVisibilitySetParams,
    async ({ params, respond, client, context }, access) => {
      const managed = access.target;
      const visibility = params.visibility;
      if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `session visibility is disabled: ${visibility}`, {
            details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
          }),
        );
        return;
      }
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const { target: current } = access.current();
        const scope = {
          agentId: current.agentId,
          sessionKey: current.canonicalKey,
          storePath: current.storePath,
        };
        // The lifecycle fence excludes canonical reset/recreate. Keep the exact
        // session-id check at the storage boundary so an out-of-band row
        // replacement still cannot inherit this visibility change.
        let inspected = false;
        let changed = false;
        await patchSessionEntryCore(
          scope,
          (entry) => {
            inspected = true;
            access.assertEntryManageable(entry);
            if (resolveSessionVisibility(entry) === visibility) {
              return null;
            }
            changed = true;
            return { visibility };
          },
          {
            assertCommitAllowed: () => {
              access.assertCurrent();
              if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
                throw new Error(`session visibility is disabled: ${visibility}`);
              }
            },
          },
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (!changed) {
          return;
        }
        const now = Date.now();
        const actor = actorIdentity(client);
        publishSharingChange({
          context,
          actor,
          event: {
            action: "visibility",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
            visibility,
            ts: now,
          },
        });
      });
      respond(true, { ok: true, sessionKey: managed.canonicalKey, visibility }, undefined);
    },
  ),

  "session.members.list": createSessionMembersListHandler("session.members.list"),
  "session.members.listEvidence": createSessionMembersListHandler("session.members.listEvidence"),

  "session.members.add": createSessionMemberMutationHandler("add"),
  "session.members.remove": createSessionMemberMutationHandler("remove"),
};
