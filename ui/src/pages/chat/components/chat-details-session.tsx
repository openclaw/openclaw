import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { ChatDetailsBackground } from "./chat-details-background.tsx";
import { ChatDetailsContext, ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import {
  ChatPullRequests,
  hasChatPullRequests,
  type ChatPullRequestsProps,
} from "./chat-pull-requests.tsx";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

type Props = { props?: ChatDetailsProps; presented: boolean; dismissed?: boolean };
export type ChatDetailsSession = SolidBridgeElement<Props>;

export const ChatDetailsSession = defineSolidBridge<Props>(
  "openclaw-chat-details-session",
  (props, host) => {
    const identity = createMemo(() =>
      JSON.stringify([
        props.props?.sessionKey,
        props.props?.currentAgentId,
        props.props?.selectedSession?.sessionId,
      ]),
    );
    return (
      <Show when={identity()} keyed>
        {(_identity) => {
          const [pullRequestsOpen, setPullRequestsOpen] = createSignal(true);
          const active = () => props.presented;
          const session = () => props.props?.selectedSession;
          const creatorName = () => session()?.createdActor?.label || session()?.createdActor?.id;
          const owner = () => session()?.owner?.actor;
          const people = () => session()?.expandedParticipants ?? session()?.participants ?? [];
          const count = () => session()?.participantCount ?? people().length;
          const pullRequests = createMemo<ChatPullRequestsProps | null>(() => {
            const snapshot = props.props;
            if (!snapshot) {
              return null;
            }
            const current = () => host.isConnected && props.presented && props.props === snapshot;
            return {
              pullRequests: snapshot.pullRequests ?? [],
              gateway: snapshot.pullRequestsGateway,
              sessionId: snapshot.pullRequestsSessionId,
              sessionKey: scopedSessionArtifactKey(
                snapshot.sessionKey,
                snapshot.currentAgentId ?? undefined,
              ),
              presented: active() && pullRequestsOpen(),
              dismissed: props.dismissed,
              branch: snapshot.pullRequestsBranch,
              branchDismissed: snapshot.pullRequestsBranchDismissed,
              status: snapshot.pullRequestsStatus ?? "ready",
              onDismiss: (pullRequest) => {
                if (current()) {
                  snapshot.onDismissPullRequest?.(pullRequest);
                }
              },
              onDismissBranch: snapshot.onDismissPullRequestsBranch
                ? (branch) => {
                    if (current()) {
                      snapshot.onDismissPullRequestsBranch?.(branch);
                    }
                  }
                : undefined,
              onOpenSessionDiff: snapshot.onOpenSessionDiff
                ? () => {
                    if (current()) {
                      snapshot.onOpenSessionDiff?.();
                    }
                  }
                : undefined,
              publication: snapshot.githubPublication,
              compact: true,
            };
          });
          return (
            <Show when={props.props}>
              <section class="chat-details-session">
                <div class="chat-details__people">
                  {creatorName() && (
                    <div class="chat-details__creator">
                      <span>{t("chat.sessionDetails.createdBy")}</span>
                      <span title={creatorName()}>{creatorName()}</span>
                    </div>
                  )}
                </div>
                <Show when={count() > 0}>
                  <div class="chat-details__meta-actions">
                    <details class="chat-details__participants">
                      <summary>
                        <Icon name="users" />
                        <span>
                          {t("chat.sessionDetails.participants", { count: String(count()) })}
                        </span>
                        <Icon name="chevronDown" />
                      </summary>
                      {owner() && (
                        <div class="chat-details__person">
                          <span>{t("chat.sessionDetails.owner")}</span>
                          <span>{owner()?.label || owner()?.id || owner()?.type}</span>
                        </div>
                      )}
                      <For each={people()}>
                        {(person) => (
                          <div class="chat-details__person">
                            <ChatAuthorAvatar
                              sender={{
                                id: person.identity.id,
                                name: person.label || person.identity.id,
                                identity: person.identity,
                                profileAvatarUrl: person.avatarUrl,
                              }}
                            />
                            <span title={person.label || person.identity.id}>
                              {person.label || person.identity.id}
                            </span>
                          </div>
                        )}
                      </For>
                      {count() > people().length && (
                        <div class="chat-details__muted">
                          {t("chat.sessionDetails.moreParticipants", {
                            count: String(count() - people().length),
                          })}
                        </div>
                      )}
                    </details>
                  </div>
                </Show>
                <ChatDetailsEnvironment details={props.props!} presented={active()} />
                <ChatDetailsContext details={props.props!} presented={active()} />
                <ChatDetailsBackground details={props.props!} presented={active()} />
                <Show when={pullRequests()}>
                  {(requests) => (
                    <Show
                      when={
                        Boolean(props.props?.onOpenSessionDiff) || hasChatPullRequests(requests())
                      }
                    >
                      <div class="chat-details__group chat-details__changes">
                        <details
                          data-details-group="pull-requests"
                          open
                          onToggle={(event) => {
                            if (event.currentTarget.isConnected) {
                              setPullRequestsOpen(event.currentTarget.open);
                            }
                          }}
                        >
                          <summary class="chat-details__caption">
                            {t("chat.sessionDetails.changes")}
                            <span>{props.props?.pullRequests?.length || null}</span>
                            <Icon name="chevronDown" />
                          </summary>
                          <ChatPullRequests {...requests()} />
                        </details>
                        {props.props?.onOpenSessionDiff && (
                          <button
                            type="button"
                            class="chat-details__all-changes"
                            onClick={() => {
                              if (host.isConnected && props.presented) {
                                props.props?.onOpenSessionDiff?.();
                              }
                            }}
                          >
                            {t("chat.sessionDetails.allChanges")}
                          </button>
                        )}
                      </div>
                    </Show>
                  )}
                </Show>
                <ChatSummaryAutomations
                  gateway={props.props?.pullRequestsGateway}
                  sessionKey={
                    props.props
                      ? scopedSessionArtifactKey(
                          props.props.sessionKey,
                          props.props.currentAgentId ?? undefined,
                        )
                      : ""
                  }
                  presented={active()}
                />
              </section>
            </Show>
          );
        }}
      </Show>
    );
  },
  {
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      dismissed: { default: false, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-session": ChatDetailsSession;
  }
}
