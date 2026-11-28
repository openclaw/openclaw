import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import {
  projectPresenceViewers,
  presenceMatchesProfile,
  projectPresencePayload,
} from "../../lib/presence-users.ts";
import { CHAT_HEADER_VIEWER_LIMIT } from "./chat-header-viewers-snapshot.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import {
  projectChatMobilePeople,
  projectSessionPeople,
  type ChatMobilePeopleMention,
} from "./chat-mobile-people.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

/** Retain each people projection independently of unrelated header updates. */
export class ChatPaneHeaderPeople {
  private readonly people = new ChatPaneHeaderMemo<ReturnType<typeof projectChatMobilePeople>>();
  private readonly viewers = new ChatPaneHeaderMemo<ReturnType<typeof projectPresenceViewers>>();
  private readonly snapshot = new ChatPaneHeaderMemo<ChatSessionSnapshot["headerViewers"]>();

  read(input: {
    host?: ChatPageHost;
    session: GatewaySessionRow | undefined;
    sharing?: SessionMembersListEvidenceResult;
    ownerCount: number;
    presence: unknown;
    selfUser: AuthenticatedUser | null | undefined;
    instanceId: string | undefined;
    sessionKey: string;
    catalog: boolean;
    detailsControl: object | undefined;
    mentionableUsers: readonly ChatMobilePeopleMention[] | undefined;
  }) {
    const { session, sharing, presence, sessionKey, mentionableUsers } = input;
    const host = input.host;
    const target = { sessionKey };
    // First-pane hydration admits this record with the transcript before attach.
    const saved = host && readChatSessionSnapshot(host.chatMessagesBySession, host, target);
    const cached = saved?.headerViewers;
    const showOwnerChip =
      input.ownerCount >= 2 ||
      (session?.participantCount ?? 0) > 0 ||
      Boolean(sharing?.members.length);
    const ownerIdentity = showOwnerChip ? session?.owner?.actor.identity : undefined;
    const viewers = input.catalog
      ? undefined
      : this.viewers.read(
          presence === undefined && cached
            ? [cached, sessionKey, session, sharing, input.detailsControl]
            : [
                presence,
                presence === undefined ? cached : undefined,
                input.selfUser,
                input.instanceId,
                sessionKey,
                input.detailsControl,
                ownerIdentity,
                showOwnerChip ? session : undefined,
                sharing,
              ],
          () => {
            const projected =
              presence === undefined && cached
                ? cached.users.map(({ profileId, ...user }) => ({
                    ...user,
                    identity: profileId ? { type: "profile" as const, id: profileId } : undefined,
                    watchedSessions: [sessionKey],
                  }))
                : projectPresenceViewers(presence, input.selfUser, input.instanceId, sessionKey);
            const staticPeople =
              !input.detailsControl && showOwnerChip ? projectSessionPeople(session, sharing) : [];
            return projected.filter(
              (viewer) =>
                !staticPeople.some(({ identity }) => presenceMatchesProfile(viewer, identity)),
            );
          },
        );
    const ownerViewing =
      presence === undefined && cached
        ? cached.ownerViewing
        : projectPresencePayload(presence).users.some(
            (user) =>
              presenceMatchesProfile(user, ownerIdentity) &&
              user.watchedSessions.includes(sessionKey),
          );
    const totalCount = presence === undefined && cached ? cached.totalCount : viewers?.length;
    if (
      !input.catalog &&
      host?.connected &&
      host.client?.recoveryScopeReady &&
      presence !== undefined &&
      saved &&
      saved.sessionId === host.currentSessionId &&
      !chatHistoryRequests(host).initialSnapshotHydration
    ) {
      // Only bounded display facts persist; collaboration still reads live presence.
      const headerViewers = this.snapshot.read([viewers, ownerViewing], () => ({
        users: (viewers ?? [])
          .slice(0, CHAT_HEADER_VIEWER_LIMIT)
          .map(({ id, identity, name, email, avatarUrl }) => ({
            id,
            profileId: identity?.id,
            name: name ?? email,
            avatarUrl,
          })),
        totalCount: totalCount ?? 0,
        ownerViewing,
      }));
      if (cached !== headerViewers && JSON.stringify(cached) !== JSON.stringify(headerViewers)) {
        cacheChatSessionSnapshot(host.chatMessagesBySession, host, target, {
          ...saved,
          headerViewers,
        });
      }
    }
    const mobilePeople = session
      ? this.people.read([session, sharing, presence, sessionKey, mentionableUsers], () =>
          projectChatMobilePeople({
            session,
            sharing,
            sessionKey,
            viewers: projectPresencePayload(presence).users,
            mentionableUsers: mentionableUsers ?? [],
          }),
        )
      : undefined;
    return { showOwnerChip, viewers, totalCount, ownerViewing, mobilePeople };
  }
}
