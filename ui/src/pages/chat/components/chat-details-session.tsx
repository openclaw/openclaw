import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { renderChatPullRequests } from "./chat-pull-requests.ts";
import "./chat-subagent-activity-live.ts";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

type Props = { props?: ChatDetailsProps; presented: boolean };
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
          const [expanded, setExpanded] = createSignal(true);
          const [pullRequestsOpen, setPullRequestsOpen] = createSignal(false);
          const [automationsOpen, setAutomationsOpen] = createSignal(false);
          const active = () => props.presented && expanded();
          const session = () => props.props?.selectedSession;
          const creatorName = () => session()?.createdActor?.label || session()?.createdActor?.id;
          const owner = () => session()?.owner?.actor;
          const people = () => session()?.expandedParticipants ?? session()?.participants ?? [];
          const count = () => session()?.participantCount ?? people().length;
          const subagents = createMemo(() =>
            props.props ? projectSubagentStatus(props.props, false).activity : [],
          );
          const pullRequests = createMemo(() => {
            const snapshot = props.props;
            if (!snapshot) {
              return null;
            }
            const current = () => host.isConnected && props.presented && props.props === snapshot;
            return renderChatPullRequests({
              pullRequests: snapshot.pullRequests ?? [],
              gateway: snapshot.pullRequestsGateway,
              sessionId: snapshot.pullRequestsSessionId,
              sessionKey: scopedSessionArtifactKey(
                snapshot.sessionKey,
                snapshot.currentAgentId ?? undefined,
              ),
              presented: active() && pullRequestsOpen(),
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
            });
          });
          return (
            <Show when={props.props}>
              <details
                class="chat-details-session"
                prop:open={expanded()}
                onToggle={(event) => {
                  if (event.currentTarget.isConnected) {
                    setExpanded(event.currentTarget.open);
                  }
                }}
              >
                <summary class="chat-details__heading">
                  {t("chat.sessionDetails.session")}
                  <Icon name="chevronDown" />
                </summary>
                <div class="chat-details__people">
                  {creatorName() && (
                    <div class="chat-details__creator">
                      <span>{t("chat.sessionDetails.createdBy")}</span>
                      <span title={creatorName()}>{creatorName()}</span>
                    </div>
                  )}
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
                          <LitContent
                            render={() =>
                              renderChatAuthorAvatar({
                                id: person.identity.id,
                                name: person.label || person.identity.id,
                                identity: person.identity,
                                profileAvatarUrl: person.avatarUrl,
                              })
                            }
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
                <div class="chat-details__workspace">
                  <div class="chat-details__row" title={props.props?.detailsWorkspace?.root ?? ""}>
                    <Icon name="folder" />
                    <span>
                      {props.props?.detailsWorkspace?.label ||
                        props.props?.detailsWorkspace?.root ||
                        t("chat.sessionDetails.workspaceUnavailable")}
                    </span>
                  </div>
                  {props.props?.detailsWorkspace?.branch && (
                    <div class="chat-details__row" title={props.props.detailsWorkspace.branch}>
                      <Icon name="gitBranch" />
                      <span>{props.props.detailsWorkspace.branch}</span>
                    </div>
                  )}
                  {props.props?.onOpenSessionDiff && (
                    <button
                      type="button"
                      class="chat-details__row"
                      onClick={() => {
                        if (host.isConnected && props.presented) {
                          props.props?.onOpenSessionDiff?.();
                        }
                      }}
                    >
                      <Icon name="diff" />
                      <span>{t("chat.sessionDetails.allChanges")}</span>
                    </button>
                  )}
                </div>
                {subagents().length > 0 && (
                  <section class="chat-details__subagents">
                    <div class="chat-details__caption">
                      {t("chat.subagentsPanel.title")}
                      <span>{subagents().length}</span>
                    </div>
                    {active() && (
                      <openclaw-chat-subagent-activity
                        prop:rows={subagents()}
                        prop:compact={true}
                        prop:onOpenSubagent={props.props?.onOpenSubagent}
                        prop:onOpenSession={props.props?.onSessionSelect}
                      />
                    )}
                  </section>
                )}
                <details
                  class="chat-details__group"
                  data-details-group="pull-requests"
                  prop:open={pullRequestsOpen()}
                  onToggle={(event) => {
                    if (event.currentTarget.isConnected) {
                      setPullRequestsOpen(event.currentTarget.open);
                    }
                  }}
                >
                  <summary class="chat-details__caption">
                    {t("chat.sessionDetails.pullRequests")}
                    <Icon name="chevronDown" />
                    <span>{props.props?.pullRequests?.length || null}</span>
                  </summary>
                  <Show
                    when={pullRequests() !== null}
                    fallback={
                      <div class="chat-details__muted">
                        {t("chat.sessionDetails.noPullRequests")}
                      </div>
                    }
                  >
                    <LitContent render={() => pullRequests()} />
                  </Show>
                </details>
                <details
                  class="chat-details__group"
                  data-details-group="automations"
                  prop:open={automationsOpen()}
                  onToggle={(event) => {
                    if (event.currentTarget.isConnected) {
                      setAutomationsOpen(event.currentTarget.open);
                    }
                  }}
                >
                  <summary class="chat-details__caption">
                    {t("chat.sessionDetails.automations")}
                    <Icon name="chevronDown" />
                  </summary>
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
                    presented={active() && automationsOpen()}
                  />
                </details>
              </details>
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
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-session": ChatDetailsSession;
  }
}
