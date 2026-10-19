import { For, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { getLocale, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { createSessionDiffSummary } from "../../../lib/session-diff-summary.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { ChatDetailsBackground } from "./chat-details-background.tsx";
import { ChatDetailsContext, ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import {
  ChatPullRequests,
  hasChatPullRequests,
  type ChatPullRequestsProps,
} from "./chat-pull-requests.tsx";
import { syncSessionPanelInputs, useSessionPanel } from "./chat-session-panel.tsx";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

type Props = { props?: ChatDetailsProps; presented: boolean; dismissed?: boolean };
export type ChatDetailsSession = SolidBridgeElement<Props>;
const diffSummaryInputs = new WeakMap<ChatDetailsSession, () => void>();

export const ChatDetailsSession = defineSolidBridge<Props>(
  "openclaw-chat-details-session",
  (props, host) => {
    // Keep the shared observation at the native host across keyed detail replacements.
    const processes = useOptionalApplication()
      ? useSessionPanel(
          host,
          () => ({
            sessionKey: host.props?.sessionKey ?? "",
            agentId: host.props?.currentAgentId ?? "main",
            presented: host.presented && Boolean(host.props?.onOpenProcesses),
          }),
          ProcessesPanelData,
          () => undefined,
        )
      : () => undefined;
    const Background = (backgroundProps: Parameters<typeof ChatDetailsBackground>[0]) =>
      ChatDetailsBackground(backgroundProps, processes);
    const changes = createSessionDiffSummary(host.ownerDocument, () => host.isConnected);
    const syncDiffSummary = () =>
      changes.update({
        gateway: host.props?.pullRequestsGateway,
        sessionKey: host.props?.sessionKey ?? "",
        agentId: host.props?.currentAgentId ?? undefined,
        sessionId: host.props?.selectedSession?.sessionId,
        presented: host.presented && Boolean(host.props?.onOpenSessionDiff),
        runActive:
          host.props?.runActive === true || host.props?.selectedSession?.hasActiveRun === true,
      });
    diffSummaryInputs.set(host, syncDiffSummary);
    onSettled(syncDiffSummary);
    onCleanup(() => {
      diffSummaryInputs.delete(host);
      changes.dispose();
    });
    const changesView = projectOwner(changes, (owner) => owner.snapshot);
    const summary = () => changesView.read().summary;
    const compactNumber = createMemo(
      () => new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }),
    );
    const fileCount = (count: number) =>
      count === 1
        ? t("chat.sessionDetails.changedFile")
        : t("chat.sessionDetails.changedFiles", { count: String(count) });
    const summaryDescription = () => {
      const value = summary();
      return [
        value
          ? t("chat.sessionDetails.changeSummary", {
              files: fileCount(value.fileCount),
              additions: String(value.additions),
              deletions: String(value.deletions),
            })
          : t("chat.sessionDetails.changesUnavailable"),
        value?.truncated ? t("chat.sessionDetails.changesPartialDescription") : "",
        changesView.read().stale ? t("chat.sessionDetails.changesStaleDescription") : "",
      ]
        .filter(Boolean)
        .join(" ");
    };
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
                <Background details={props.props!} presented={active()} />
                <Show when={pullRequests()}>
                  {(requests) => (
                    <Show
                      when={
                        Boolean(props.props?.onOpenSessionDiff) || hasChatPullRequests(requests())
                      }
                    >
                      <div
                        class={[
                          "chat-details__group",
                          "chat-details__changes",
                          {
                            "chat-details__changes--summary": Boolean(
                              props.props?.onOpenSessionDiff,
                            ),
                          },
                        ]}
                      >
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
                            aria-label={t("chat.sessionDetails.allChanges")}
                            aria-description={summaryDescription()}
                            title={summaryDescription()}
                            onClick={() => {
                              if (host.isConnected && props.presented) {
                                props.props?.onOpenSessionDiff?.();
                              }
                            }}
                          >
                            <span>{t("chat.sessionDetails.allChanges")}</span>
                            <span class="chat-details__change-summary" aria-hidden="true">
                              <Show
                                when={summary()}
                                fallback={
                                  <span class="chat-details__change-status">
                                    {changesView.read().unavailable
                                      ? t("chat.sessionDetails.changesUnavailableShort")
                                      : "—"}
                                  </span>
                                }
                              >
                                {(value) => (
                                  <>
                                    <span class="chat-details__change-files">
                                      {fileCount(value().fileCount)}
                                    </span>
                                    <span
                                      class={[
                                        "chat-details__change-lines",
                                        {
                                          "chat-details__change-lines--add": value().additions > 0,
                                        },
                                      ]}
                                    >
                                      +{compactNumber().format(value().additions)}
                                    </span>
                                    <span
                                      class={[
                                        "chat-details__change-lines",
                                        {
                                          "chat-details__change-lines--del": value().deletions > 0,
                                        },
                                      ]}
                                    >
                                      −{compactNumber().format(value().deletions)}
                                    </span>
                                    {value().truncated && (
                                      <span class="chat-details__change-status">
                                        {t("chat.sessionDetails.changesPartial")}
                                      </span>
                                    )}
                                    {changesView.read().stale && (
                                      <span class="chat-details__change-status">
                                        {t("chat.sessionDetails.changesStale")}
                                      </span>
                                    )}
                                  </>
                                )}
                              </Show>
                            </span>
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
    propertyChanged: (host, key) => {
      if (key === "props" || key === "presented") {
        syncSessionPanelInputs(host);
        diffSummaryInputs.get(host)?.();
      }
    },
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
