import { For, Show, createMemo, createSignal, createStore, lazy, onSettled } from "solid-js";
import type { SessionParticipant } from "../../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerSessionProgressEnglish } from "../../../i18n/locales/en-session-progress.ts";
import { sessionParticipantIdentityKey } from "../../../lib/chat/sender-label.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollPosition } from "../../../lib/reactive/scroll-state.ts";
import { scopedSessionArtifactKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { ChatDetailsBackground } from "./chat-details-background.tsx";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import { ChatDetailsPeopleSummary } from "./chat-details-people.tsx";
import { ChatDetailsProcesses } from "./chat-details-processes.tsx";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import type {
  ChatDetailsDesktopSectionId,
  ChatDetailsOutputs,
  ChatDetailsProps,
} from "./chat-details-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { getChatOutputsCount, hasChatDesktopOutputs } from "./chat-outputs-data.ts";
import { isProcessesPresentationReady } from "./chat-processes-presentation.ts";
import { ChatPullRequests, type ChatPullRequestsProps } from "./chat-pull-requests.tsx";
import { syncSessionPanelInputs, useSessionPanel } from "./chat-session-panel.tsx";
import { ChatSummaryAutomations } from "./chat-summary-automations.tsx";

registerEnglishCatalog(registerSessionProgressEnglish);

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

const ChatDetailsPeople = lazy(() => import("./chat-details-people-list.tsx"), {
  export: "ChatDetailsPeople",
});
const ChatOutputsDesktop = lazy(() => import("./chat-outputs.tsx"), {
  export: "ChatOutputsDesktop",
});

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  dismissed?: boolean;
  scrollport?: HTMLElement;
  /** Set by ChatDetails from its native presentation context, never pane width. */
  desktop?: boolean;
};
export type ChatDetailsSession = SolidBridgeElement<Props>;

function DetailsAutomations(props: Props) {
  const identity = createMemo(
    () =>
      [
        props.props?.sessionKey,
        props.props?.currentAgentId,
        props.props?.selectedSession?.sessionId,
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  // Reset disclosure state with the incarnation; the inventory owns its logical scope.
  const [expanded, setExpanded] = createSignal<boolean>(() => {
    identity();
    return true;
  });
  const desktop = createMemo(
    () =>
      props.desktop
        ? {
            expanded: props.props?.desktopDisclosures?.expanded.automations ?? expanded(),
            onExpandedChange: (next: boolean) => {
              if (props.presented) {
                setExpanded(next);
                props.props?.desktopDisclosures?.onExpandedChange("automations", next);
              }
            },
          }
        : undefined,
    { equals: (before, after) => before?.expanded === after?.expanded },
  );
  return (
    <ChatSummaryAutomations
      presentationIdentity={identity()}
      desktop={desktop()}
      gateway={props.props?.pullRequestsGateway}
      sessionKey={
        props.props
          ? scopedSessionArtifactKey(
              props.props.sessionKey,
              props.props.currentAgentId ?? undefined,
            )
          : ""
      }
      presented={props.presented}
    />
  );
}

export const ChatDetailsSession = defineSolidBridge<Props>(
  "openclaw-chat-details-session",
  (props, host) => {
    // Keep the shared observation at the native host across keyed detail replacements.
    const context = useOptionalApplication();
    const gateway = context ? projectGateway(context.gateway) : undefined;
    const processes = context
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
    const readIdentity = () =>
      JSON.stringify([
        props.props?.sessionKey,
        props.props?.currentAgentId,
        props.props?.selectedSession?.sessionId,
      ]);
    const identity = createMemo(readIdentity);
    createScrollPosition(() => {
      const owner = processes();
      return {
        retain: props.scrollport
          ? {
              identity: [identity()],
              target: props.scrollport,
              presented: props.presented,
              ready: isProcessesPresentationReady(owner, gateway?.read().snapshot),
            }
          : undefined,
      };
    });
    return (
      <Show when={identity()} keyed>
        {(_identity) => {
          const [pullRequestsOpen, setPullRequestsOpen] = createSignal(true);
          const [sectionChoices, setSectionChoices] = createStore<
            Partial<Record<ChatDetailsDesktopSectionId, boolean>>
          >({});
          const desktopPresentation = () =>
            props.desktop ? props.props?.desktopPresentation : undefined;
          const sectionExpanded = (section: ChatDetailsDesktopSectionId) =>
            props.props?.desktopDisclosures?.expanded[section] ??
            sectionChoices[section] ??
            (section === "environment" ||
              section === "subagents" ||
              section === "automations" ||
              section === "processes");
          const changeSection = (section: ChatDetailsDesktopSectionId, expanded: boolean) => {
            if (!host.isConnected || !props.presented || sectionExpanded(section) === expanded) {
              return;
            }
            setSectionChoices((choices) => {
              choices[section] = expanded;
            });
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
          const requestsExpanded = () =>
            (props.desktop
              ? props.props?.desktopDisclosures?.expanded["pull-requests"]
              : undefined) ?? pullRequestsOpen();
          const active = () => props.presented;
          const session = () => props.props?.selectedSession;
          const creatorName = () => session()?.createdActor?.label || session()?.createdActor?.id;
          const owner = () => session()?.owner?.actor;
          const OwnerAttribution = () => (
            <div class="chat-details__person">
              <span>{t("chat.sessionDetails.owner")}</span>
              <span ref={createTextOverflow(() => owner()?.label || owner()?.id || owner()?.type)}>
                {owner()?.label || owner()?.id || owner()?.type}
              </span>
            </div>
          );
          const people = () => session()?.expandedParticipants ?? session()?.participants ?? [];
          const count = () => session()?.participantCount ?? people().length;
          const partialPeople = () =>
            session()?.participantCount === undefined || count() > people().length;
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
            const navigationIdentity = readIdentity();
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
                // Native props can advance before the visible Outputs row settles.
                if (host.isConnected && props.presented && readIdentity() === navigationIdentity) {
                  props.props?.outputs?.onViewAll();
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
                            <span ref={createTextOverflow(creatorName)} title={creatorName()}>
                              {creatorName()}
                            </span>
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
                            {owner() && <OwnerAttribution />}
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
                                  <span
                                    ref={createTextOverflow(
                                      () => person.label || person.identity.id,
                                    )}
                                    title={person.label || person.identity.id}
                                  >
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
                      <ChatDetailsEnvironment
                        {...props.props?.environment}
                        details={props.props!}
                        presented={active()}
                        work={pullRequests() ?? undefined}
                      />
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
                                partial={partialPeople()}
                                expanded={sectionExpanded("people")}
                              />
                            </Show>
                          }
                        >
                          <ChatLazyBoundary>
                            <ChatDetailsPeople
                              people={desktopPeople()}
                              ownerIdentity={owner()?.identity}
                              personActivity={props.props?.personActivity}
                            />
                          </ChatLazyBoundary>
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
                              <span ref={createTextOverflow(creatorName)} title={creatorName()}>
                                {creatorName()}
                              </span>
                            </div>
                          </Show>
                          <Show when={owner() && !owner()?.identity}>
                            <OwnerAttribution />
                          </Show>
                        </ChatDetailsDesktopSection>
                      </Show>
                      <ChatDetailsEnvironment
                        {...props.props?.environment}
                        work={pullRequests() ?? undefined}
                        details={props.props!}
                        presented={active()}
                        expanded={sectionExpanded("environment")}
                        onExpandedChange={(expanded) => changeSection("environment", expanded)}
                      />
                    </>
                  )}
                </Show>
                <Show when={!props.desktop}>
                  <Background details={props.props!} presented={active()} />
                </Show>
                <Show when={pullRequests()}>
                  {(requests) => (
                    <Show
                      when={
                        requests().pullRequests.length > 0 ||
                        requests().publication?.result?.status === "published"
                      }
                    >
                      <div class="chat-details__group chat-details__changes">
                        <Show
                          when={!props.desktop}
                          fallback={
                            <ChatDetailsDesktopSection
                              section="pull-requests"
                              title={t("chat.sessionDetails.pullRequests")}
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
                              <ChatPullRequests {...requests()} publishedOnly />
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
                              {t("chat.sessionDetails.pullRequests")}
                              <span>{props.props?.pullRequests?.length || null}</span>
                              <Icon name="chevronDown" />
                            </summary>
                            <ChatPullRequests {...requests()} publishedOnly />
                          </details>
                        </Show>
                      </div>
                    </Show>
                  )}
                </Show>
                <Show when={!props.desktop}>
                  <DetailsAutomations props={props.props} presented={active()} />
                </Show>
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
                    <Show when={hasChatDesktopOutputs(data())}>
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
                        <ChatLazyBoundary>
                          <ChatOutputsDesktop {...data()} />
                        </ChatLazyBoundary>
                      </ChatDetailsDesktopSection>
                    </Show>
                  )}
                </Show>
              </section>
            </Show>
          );
        }}
      </Show>
    );
  },
  {
    propertyChanged: (host, key) => {
      if (key === "props" || key === "presented" || key === "desktop") {
        syncSessionPanelInputs(host);
      }
    },
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      scrollport: { default: undefined, attribute: false },
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
  onReady?: () => void;
};

/** Desktop entry point: one scroll body and the native Progress owner after Outputs. */
export function ChatDetailsDesktopComposition(props: ChatDetailsDesktopCompositionProps) {
  onSettled(() => {
    props.onReady?.();
  });
  return (
    <>
      <ChatDetailsSession
        props={props.props}
        presented={props.presented}
        dismissed={props.dismissed}
        scrollport={props.scrollport}
        desktop
      />
      <Show when={props.props?.progressCard}>
        <ChatDetailsProgress
          desktop
          props={props.props}
          presented={props.presented}
          menuRef={props.progressMenuRef}
          onHideProgress={props.onHideProgress}
        />
      </Show>
      <Show when={!props.props?.progressCard && props.props?.progressCardError === "access-denied"}>
        <div class="chat-details__muted" role="status">
          {t("sessionProgressCard.widgetAccessDenied")}
        </div>
      </Show>
      {/* Its separate inventory can arrive after the session. Append it so
          loading automation rows never displaces the existing sections. */}
      <DetailsAutomations props={props.props} presented={props.presented} desktop />
    </>
  );
}
