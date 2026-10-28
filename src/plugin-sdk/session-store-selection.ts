import type { SessionCatalogSourceProfileRelation } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionCatalogRelationIdentity } from "../gateway/session-catalog-identity.js";
import {
  filterSessionEntriesByProfile,
  projectSessionOwner,
  projectSessionRelatedProfileIds,
  type SessionActorProfileIdentity,
} from "../gateway/session-identity-projection.js";
import { prepareCurrentUserProfileIdentity } from "../state/user-profile-reads.js";
import {
  projectPluginSessionEntry,
  type SessionStoreEntrySummary,
} from "./session-store-runtime-internal.js";

export type SessionStoreSelectedEntries = {
  agentId: string;
  storePath: string;
  sessionKeys: readonly string[];
};

export type SessionStoreSelectedEntry = SessionStoreEntrySummary & {
  agentId: string;
  storePath: string;
};

/**
 * Prepare selected stores and a fresh profile snapshot off-thread, then consume synchronously.
 * Final native session guards observe cross-process commits; stores are not one atomic snapshot.
 * Relationship matching uses the same canonical owner/participant/mention projection as sessions.list.
 * Returned data carries no authority after the callback; caller policy must be checked inside it.
 */
export async function withSessionEntriesAsync<T>(
  params: {
    stores: readonly SessionStoreSelectedEntries[];
    env?: NodeJS.ProcessEnv;
    involvingProfileId?: string;
    profileRelation?: SessionCatalogSourceProfileRelation;
    config?: OpenClawConfig;
  },
  consume: (entries: SessionStoreSelectedEntry[]) => T,
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const publicationProfileId = params.involvingProfileId;
  let publicationIdentity:
    | Awaited<ReturnType<typeof prepareCurrentUserProfileIdentity>>
    | undefined;
  const relation = params.profileRelation && {
    relationship: params.profileRelation.relationship,
    target: { ...params.profileRelation.target },
  };
  const stores = params.stores.map((store) => ({
    ...store,
    sessionKeys: [...store.sessionKeys],
  }));
  let relationIdentity:
    | Awaited<ReturnType<typeof prepareSessionCatalogRelationIdentity>>
    | undefined;
  return await withSessionEntriesFromStoresInWorker(
    stores.map((store) => ({ ...store, env, projection: "list" as const })),
    (reads) => {
      publicationIdentity?.assertCurrent();
      relationIdentity?.assertCurrent();
      // Writer queues cover this process only. Keep the selected-key native guard
      // after all awaits so a separate Gateway's committed revocation is visible.
      const entries = stores.flatMap((store) =>
        listAccessorSessionEntriesReadOnly({
          ...store,
          env,
          projection: "list",
          includeParticipants: publicationProfileId !== undefined || relation !== undefined,
        }).map(({ sessionKey, entry }) => ({
          agentId: store.agentId,
          storePath: store.storePath,
          sessionKey,
          entry,
        })),
      );
      const published =
        publicationProfileId !== undefined
          ? filterSessionEntriesByProfile({ entries, profile: publicationIdentity?.profile })
          : entries;
      const selectionIdentity = relationIdentity;
      const selected =
        relation && selectionIdentity
          ? published.filter(({ entry }) => {
              const profile = selectionIdentity.profile;
              const identities = new Map<string, SessionActorProfileIdentity | undefined>();
              // Only the target's canonical equivalence class is needed; all other IDs stay unrelated.
              const ids = [
                entry.owner?.actor.id,
                entry.owner?.assignedBy?.id,
                sessionCreatorProfileId(entry.createdActor),
                ...(entry.participants ?? []).flatMap(({ identity }) =>
                  identity.type === "profile" ? [identity.id] : [],
                ),
                ...Object.keys(entry.profileInvolvement?.profiles ?? {}),
              ];
              for (const id of ids) {
                if (id) {
                  identities.set(
                    id,
                    profile.aliases.has(id)
                      ? {
                          kind: "resolved",
                          profileId: profile.profileId,
                          avatarUrl: "",
                          hasUploadedAvatar: false,
                        }
                      : undefined,
                  );
                }
              }
              const owner = projectSessionOwner(entry, identities, params.config ?? {})?.actor;
              return relation.relationship === "owned"
                ? owner?.identity?.type === "profile" && owner.identity.id === profile.profileId
                : projectSessionRelatedProfileIds(entry, identities, owner).has(profile.profileId);
            })
          : published;
      reads.forEach((read) => read.assertCurrent());
      publicationIdentity?.assertCurrent();
      relationIdentity?.assertCurrent();
      return consume(
        selected.map(({ entry, agentId, storePath, sessionKey }) => ({
          agentId,
          storePath,
          sessionKey,
          entry: projectPluginSessionEntry(entry),
        })),
      );
    },
    {
      ordered: true,
      ...(publicationProfileId !== undefined || relation !== undefined
        ? {
            prepareConsume: async () => {
              if (publicationProfileId !== undefined) {
                publicationIdentity = await prepareCurrentUserProfileIdentity(
                  publicationProfileId,
                  { env },
                );
              }
              if (relation !== undefined) {
                relationIdentity = await prepareSessionCatalogRelationIdentity(relation, { env });
              }
            },
          }
        : {}),
    },
  );
}
