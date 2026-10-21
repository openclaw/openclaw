import { For, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { getLocale, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { createSessionDiffSummary } from "../../../lib/session-diff-summary.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import { ChatDetailsBackground } from "./chat-details-background.tsx";
import { ChatDetailsContextContent, ChatDetailsContextSummary } from "./chat-details-context.tsx";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { ChatDetailsContext, ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import { ChatDetailsPeople, ChatDetailsPeopleSummary } from "./chat-details-people.tsx";
import { ChatDetailsProcesses } from "./chat-details-processes.tsx";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import type {
  ChatDetailsDesktopSectionId,
  ChatDetailsOutputs,
  ChatDetailsProps,
} from "./chat-details-types.ts";
import { ChatOutputsDesktop, getChatOutputsCount, isChatOutputsEmpty } from "./chat-outputs.tsx";
import { hasChatPullRequests } from "./chat-pull-requests.ts";
import { ChatPullRequests, type ChatPullRequestsProps } from "./chat-pull-requests.tsx";
import { syncSessionPanelInputs, useSessionPanel } from "./chat-session-panel.tsx";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  dismissed?: boolean;
  /** Set by ChatDetails from its native presentation context, never pane width. */
  desktop?: boolean;
};
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
        presented: host.presented && !host.desktop && Boolean(host.props?.onOpenSessionDiff),
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
    const outputsDemand = createMemo(() =>
      props.presented && props.desktop && props.props?.outputs
        ? props.props.retainOutputs
        : undefined,
    );
    return [
      <Show when={outputsDemand()} keyed>
        {(retain) => {
          onSettled(retain);
          return null;
        }}
      </Show>,
      <Show when={identity()} keyed>
        {(_identity) => {
          const [pullRequestsOpen, setPullRequestsOpen] = createSignal(true);
          const [sectionChoices, setSectionChoices] = createSignal<
            Partial<Record<ChatDetailsDesktopSectionId, boolean>>
          >({});
          const desktopPresentation = () =>
            props.desktop ? props.props?.desktopPresentation : undefined;
          const sectionExpanded = (section: ChatDetailsDesktopSectionId) =>
            props.props?.desktopDisclosures?.expanded[section] ??
            sectionChoices()[section] ??
            (section === "environment" ||
              section === "subagents" ||
              section === "automations" ||
              section === "processes");
          const changeSection = (section: ChatDetailsDesktopSectionId, expanded: boolean) => {
            if (!host.isConnected || !props.presented || sectionExpanded(section) === expanded) {
              return;
            }
            setSectionChoices((previous) => ({ ...previous, [section]: expanded }));
            props.props?.desktopDisclosures?.onExpandedChange(section, expanded);
          };
          const changeSubagentsExpanded = (expanded: boolean) =>
            changeSection("subagents", expanded);
          const desktopSubagentsPresentation = createMemo(
            () => {
              const presentation = desktopPresentation();
              return presentation
                ? {
                    expanded: sectionExpanded("subagents"),
                    onExpandedChange: changeSubagentsExpanded,
                    workingLabel: presentation.subagentsWorkingLabel,
                  }
                : undefined;
            },
            {
              equals: (before, after) =>
                before?.expanded === after?.expanded &&
                before?.workingLabel === after?.workingLabel,
            },
          );
          const changeAutomationsExpanded = (expanded: boolean) =>
            changeSection("automations", expanded);
          const desktopAutomations = createMemo(
            () =>
              props.desktop
                ? {
                    expanded: sectionExpanded("automations"),
                    onExpandedChange: changeAutomationsExpanded,
                  }
                : undefined,
            { equals: (before, after) => before?.expanded === after?.expanded },
          );
          const requestsExpanded = () =>
            (props.desktop
              ? props.props?.desktopDisclosures?.expanded["pull-requests"]
              : undefined) ?? pullRequestsOpen();
          const active = () => props.presented;
          const openAllChanges = () => {
            if (host.isConnected && props.presented) {
              props.props?.onOpenSessionDiff?.();
            }
          };
          const session = () => props.props?.selectedSession;
          const creatorName = () => session()?.createdActor?.label || session()?.createdActor?.id;
          const owner = () => session()?.owner?.actor;
          const people = () => session()?.expandedParticipants ?? session()?.participants ?? [];
          const count = () => session()?.participantCount ?? people().length;
          const desktopPeople = createMemo(() => {
            const union = new Map<string, SessionParticipant>();
            const actors = [owner(), session()?.createdActor];
            const projectedActors = actors.flatMap((actor): SessionParticipant[] =>
              actor?.identity
                ? [{ identity: actor.identity, label: actor.label, avatarUrl: actor.avatarUrl }]
                : [],
            );
            for (const person of [...projectedActors, ...people()]) {
              const key = sessionParticipantIdentityKey(person.identity);
              const previous = union.get(key);
              union.set(key, {
                identity: person.identity,
                label: person.label ?? previous?.label,
                avatarUrl: person.avatarUrl ?? previous?.avatarUrl,
              });
            }
            return [...union.values()];
          });
          const outputs = createMemo<ChatDetailsOutputs | null>(() => {
            const snapshot = props.props?.outputs;
            if (!snapshot) {
              return null;
            }
            const current = () =>
              host.isConnected && props.presented && props.props?.outputs === snapshot;
            return {
              ...snapshot,
              onOpenArtifact: (id) => {
                if (current()) {
                  snapshot.onOpenArtifact(id);
                }
              },
              onViewAll: () => {
                if (current()) {
                  snapshot.onViewAll();
                }
              },
              onRetryArtifacts: snapshot.onRetryArtifacts
                ? () => {
                    if (current()) {
                      snapshot.onRetryArtifacts?.();
                    }
                  }
                : undefined,
              onRetryDashboard: snapshot.onRetryDashboard
                ? () => {
                    if (current()) {
                      snapshot.onRetryDashboard?.();
                    }
                  }
                : undefined,
              dashboard: snapshot.dashboard
                ? {
                    title: snapshot.dashboard.title,
                    onOpen: () => {
                      if (current()) {
                        snapshot.dashboard?.onOpen();
                      }
                    },
                  }
                : snapshot.dashboard,
            };
          });
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
              presented: active() && requestsExpanded(),
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
              <section
                class="chat-details-session"
                data-details-desktop={props.desktop ? "" : undefined}
              >
                <Show
                  when={desktopPresentation()}
                  fallback={
                    <>
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
                                {t("chat.sessionDetails.participants", {
                                  count: String(count()),
                                })}
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
                    </>
                  }
                >
                  {(presentation) => (
                    <>
                      <Show
                        when={desktopPeople().length > 0 || count() > 0 || creatorName() || owner()}
                      >
                        <ChatDetailsDesktopSection
                          section="people"
                          title={presentation().peopleLabel}
                          expanded={sectionExpanded("people")}
                          presented={active()}
                          onExpandedChange={(expanded) => changeSection("people", expanded)}
                          metadata={
                            <Show when={desktopPeople().length > 0}>
                              <ChatDetailsPeopleSummary
                                people={desktopPeople()}
                                expanded={sectionExpanded("people")}
                              />
                            </Show>
                          }
                        >
                          <ChatDetailsPeople
                            people={desktopPeople()}
                            ownerIdentity={owner()?.identity}
                            personActivity={props.props?.personActivity}
                          />
                          <Show when={count() > people().length}>
                            <div class="chat-details__muted">
                              {t("chat.sessionDetails.moreParticipants", {
                                count: String(count() - people().length),
                              })}
                            </div>
                          </Show>
                          {/* Keep native attribution readable until its display identity is projected. */}
                          <Show when={creatorName() && !session()?.createdActor?.identity}>
                            <div class="chat-details__creator">
                              <span>{t("chat.sessionDetails.createdBy")}</span>
                              <span title={creatorName()}>{creatorName()}</span>
                            </div>
                          </Show>
                          <Show when={owner() && !owner()?.identity}>
                            <div class="chat-details__person">
                              <span>{t("chat.sessionDetails.owner")}</span>
                              <span>{owner()?.label || owner()?.id || owner()?.type}</span>
                            </div>
                          </Show>
                        </ChatDetailsDesktopSection>
                      </Show>
                      <ChatDetailsEnvironment
                        {...props.props?.environment}
                        details={props.props!}
                        presented={active()}
                        expanded={sectionExpanded("environment")}
                        onExpandedChange={(expanded) => changeSection("environment", expanded)}
                      />
                    </>
                  )}
                </Show>
                <Show
                  when={props.desktop}
                  fallback={<ChatDetailsContext details={props.props!} presented={active()} />}
                >
                  <Show when={getContextNoticeViewModel(session())}>
                    <ChatDetailsDesktopSection
                      section="context"
                      title={t("chat.sessionDetails.context")}
                      expanded={sectionExpanded("context")}
                      presented={active()}
                      onExpandedChange={(expanded) => changeSection("context", expanded)}
                      metadata={
                        <span class="chat-details-desktop-context-summary">
                          <ChatDetailsContextSummary details={props.props!} />
                        </span>
                      }
                    >
                      <ChatDetailsContextContent
                        desktop
                        details={props.props!}
                        presented={active() && sectionExpanded("context")}
                      />
                    </ChatDetailsDesktopSection>
                  </Show>
                </Show>
                <Show when={!props.desktop}>
                  <Background details={props.props!} presented={active()} />
                </Show>
                <Show when={pullRequests()}>
                  {(requests) => (
                    <Show
                      when={
                        (!props.desktop && Boolean(props.props?.onOpenSessionDiff)) ||
                        hasChatPullRequests(requests())
                      }
                    >
                      <div
                        class={[
                          "chat-details__group",
                          "chat-details__changes",
                          {
                            "chat-details__changes--summary":
                              !props.desktop && Boolean(props.props?.onOpenSessionDiff),
                          },
                        ]}
                      >
                        <Show
                          when={!props.desktop}
                          fallback={
                            <ChatDetailsDesktopSection
                              section="pull-requests"
                              title={t("sessionHovercard.pullRequests")}
                              expanded={requestsExpanded()}
                              presented={active()}
                              onExpandedChange={(expanded) => {
                                setPullRequestsOpen(expanded);
                                props.props?.desktopDisclosures?.onExpandedChange(
                                  "pull-requests",
                                  expanded,
                                );
                              }}
                            >
                              <ChatPullRequests {...requests()} />
                            </ChatDetailsDesktopSection>
                          }
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
                        </Show>
                        {props.props?.onOpenSessionDiff && !props.desktop && (
                          <button
                            type="button"
                            class="chat-details__all-changes"
                            aria-label={t("chat.sessionDetails.allChanges")}
                            aria-description={summaryDescription()}
                            title={summaryDescription()}
                            onClick={openAllChanges}
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
                  desktop={desktopAutomations()}
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
                <Show when={props.desktop}>
                  <Background
                    details={props.props!}
                    presented={active()}
                    desktopSubagents={desktopSubagentsPresentation()}
                    showProcesses={false}
                  />
                  <ChatDetailsProcesses
                    processes={processes}
                    presented={active()}
                    expanded={sectionExpanded("processes")}
                    onExpandedChange={(expanded) => changeSection("processes", expanded)}
                    onOpen={props.props?.onOpenProcesses}
                  />
                </Show>
                <Show when={desktopPresentation() && outputs()}>
                  {(data) => (
                    <Show when={!isChatOutputsEmpty(data())}>
                      <ChatDetailsDesktopSection
                        section="outputs"
                        title={desktopPresentation()!.outputsLabel}
                        expanded={sectionExpanded("outputs")}
                        presented={active()}
                        onExpandedChange={(expanded) => changeSection("outputs", expanded)}
                        metadata={
                          <Show when={getChatOutputsCount(data()) !== null}>
                            <span class="chat-details-desktop-section__count">
                              <span
                                class="chat-details-desktop-section__count-separator"
                                aria-hidden="true"
                              >
                                ·
                              </span>
                              {getChatOutputsCount(data())}
                            </span>
                          </Show>
                        }
                      >
                        <ChatOutputsDesktop {...data()} />
                      </ChatDetailsDesktopSection>
                    </Show>
                  )}
                </Show>
              </section>
            </Show>
          );
        }}
      </Show>,
    ];
  },
  {
    propertyChanged: (host, key) => {
      if (key === "props" || key === "presented" || key === "desktop") {
        syncSessionPanelInputs(host);
        diffSummaryInputs.get(host)?.();
      }
    },
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      dismissed: { default: false, type: Boolean },
      desktop: { default: false, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-session": ChatDetailsSession;
  }
}

export type ChatDetailsDesktopCompositionProps = Omit<Props, "desktop"> & {
  /** The native host keeps ownership of top-layer menus and Undo/focus behavior. */
  progressMenuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};

/** Desktop entry point: one scroll body and the native Progress owner after Outputs. */
export function ChatDetailsDesktopComposition(props: ChatDetailsDesktopCompositionProps) {
  return (
    <ChatDetailsDesktopBody presented={props.presented}>
      <ChatDetailsSession
        props={props.props}
        presented={props.presented}
        dismissed={props.dismissed}
        desktop
      />
      <Show
        when={
          props.props?.progressCard ||
          (props.props?.progressCardInitialLoading && !props.props?.progressCardError)
        }
      >
        <ChatDetailsProgress
          desktop
          props={props.props}
          presented={props.presented}
          menuRef={props.progressMenuRef}
          onHideProgress={props.onHideProgress}
        />
      </Show>
      <Show when={!props.props?.progressCard && props.props?.progressCardError}>
        {(error) => (
          <div class="chat-details__muted" role="status">
            {t(
              error() === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}
          </div>
        )}
      </Show>
    </ChatDetailsDesktopBody>
  );
}
