import type { GatewaySessionRow } from "../../api/types.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import {
  projectPresenceViewers,
  presenceMatchesProfile,
  projectPresencePayload,
} from "../../lib/presence-users.ts";
import { projectChatMobilePeople, type ChatMobilePeopleMention } from "./chat-mobile-people.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";

/** Retain each people projection independently of unrelated header updates. */
export class ChatPaneHeaderPeople {
  private readonly people = new ChatPaneHeaderMemo<ReturnType<typeof projectChatMobilePeople>>();
  private readonly viewers = new ChatPaneHeaderMemo<ReturnType<typeof projectPresenceViewers>>();

  read(input: {
    session: GatewaySessionRow | undefined;
    ownerCount: number;
    presence: unknown;
    selfUser: AuthenticatedUser | null | undefined;
    instanceId: string | undefined;
    sessionKey: string;
    catalog: boolean;
    detailsControl: object | undefined;
    mentionableUsers: readonly ChatMobilePeopleMention[] | undefined;
  }) {
    const { session, presence, sessionKey, mentionableUsers } = input;
    const showOwnerChip = input.ownerCount >= 2 || (session?.participantCount ?? 0) > 0;
    const ownerIdentity = showOwnerChip ? session?.owner?.actor.identity : undefined;
    const viewers = input.catalog
      ? undefined
      : this.viewers.read(
          [
            presence,
            input.selfUser,
            input.instanceId,
            sessionKey,
            input.detailsControl,
            ownerIdentity,
            showOwnerChip ? session?.participants : undefined,
          ],
          () =>
            projectPresenceViewers(
              presence,
              input.selfUser,
              input.instanceId,
              sessionKey,
              input.detailsControl
                ? []
                : [
                    ...(ownerIdentity ? [ownerIdentity] : []),
                    ...(showOwnerChip
                      ? (session?.participants ?? []).map(({ identity }) => identity)
                      : []),
                  ],
            ),
        );
    const ownerViewing = projectPresencePayload(presence).users.some(
      (user) =>
        presenceMatchesProfile(user, ownerIdentity) && user.watchedSessions.includes(sessionKey),
    );
    const mobilePeople = session
      ? this.people.read([session, presence, sessionKey, mentionableUsers], () =>
          projectChatMobilePeople({
            session,
            sessionKey,
            viewers: projectPresencePayload(presence).users,
            mentionableUsers: mentionableUsers ?? [],
          }),
        )
      : undefined;
    return { showOwnerChip, viewers, ownerViewing, mobilePeople };
  }
}
