import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { registerChatDetailsEnglish } from "../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { PluginContributions } from "../../plugins/control-ui-contributions.solid.tsx";
import type { ChatMobileHost, MobileDetailsRoute } from "./chat-mobile-host.ts";
import type { ChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import type { ChatMobilePeople } from "./chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./components/chat-author-avatar-view.tsx";
import type { ChatDetailsGoalProps } from "./components/chat-details-goal.tsx";
import {
  ChatDetailsMobileContent,
  ChatDetailsMobileControls,
  type ChatDetailsMobilePage,
} from "./components/chat-details-mobile-content.tsx";
import { createDetailsProcessesPresentation } from "./components/chat-details-processes-presentation.ts";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import {
  createProcessesPresentation,
  isProcessesPresentationReady,
} from "./components/chat-processes-presentation.ts";
import { syncSessionPanelInputs, useSessionPanel } from "./components/chat-session-panel.tsx";
import { createChatSessionSharingMobileAdapter } from "./components/chat-session-sharing-mobile-adapter.tsx";
import type { PreparedChatSessionSharing } from "./components/chat-session-sharing-shared.tsx";
import type { ChatSessionVersionsMobileProps } from "./components/chat-session-versions-mobile.tsx";
import { createSessionAutomationInventory } from "./components/chat-summary-automations.tsx";
import { ProcessesPanelData } from "./processes-panel-data.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export type MobileDetailsBindings = {
  sharing?: PreparedChatSessionSharing;
  people?: ChatMobilePeople;
  peopleMentions?: ChatMobilePeopleMentions;
  goal: Omit<ChatDetailsGoalProps, "goal" | "presented">;
  versions?: ChatSessionVersionsMobileProps;
};

type MobileHostContentProps = {
  details?: ChatDetailsProps;
  host?: ChatMobileHost;
  bindings?: MobileDetailsBindings;
  presented: boolean;
};
export type ChatDetailsMobileHostContent = SolidBridgeElement<MobileHostContentProps>;

/** Native input receipts retire old process demand before the next rendered presentation. */
export const ChatDetailsMobileHostContent = defineSolidBridge<MobileHostContentProps>(
  "openclaw-chat-details-mobile-host-content",
  (props, nativeHost) => {
    nativeHost.style.display = "contents";
    const Content = (contentProps: Parameters<typeof MobileHostContent>[0]) =>
      MobileHostContent(contentProps, nativeHost);
    return (
      <Show when={props.details && props.host}>
        <Content
          details={props.details!}
          host={props.host!}
          bindings={props.bindings}
          presented={props.presented}
        />
      </Show>
    );
  },
  {
    propertyChanged: syncSessionPanelInputs,
    properties: {
      details: { default: undefined, attribute: false },
      host: { default: undefined, attribute: false },
      bindings: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
    },
  },
);

/** A retained presenter under the existing host. Routes and Back remain pane-owned. */
function MobileHostContent(
  props: {
    details: ChatDetailsProps;
    host: ChatMobileHost;
    bindings?: MobileDetailsBindings;
    presented: boolean;
  },
  nativeHost: ChatDetailsMobileHostContent,
) {
  const context = useOptionalApplication();
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const processes = context
    ? useSessionPanel(
        nativeHost,
        () => ({
          sessionKey: nativeHost.details?.sessionKey ?? "",
          agentId: nativeHost.details?.currentAgentId ?? "main",
          presented: nativeHost.presented && Boolean(nativeHost.details?.onOpenProcesses),
        }),
        ProcessesPanelData,
        () => {},
      )
    : () => undefined;
  const processPresentation = createProcessesPresentation(processes, true);
  const detailsProcesses = createDetailsProcessesPresentation(
    () => processes()?.snapshot.rows ?? [],
  );
  const processData = createMemo(() => {
    const data = processes();
    if (!data) {
      return undefined;
    }
    const { error, errorKind, loading, hasResult } = data.snapshot;
    return {
      rows: detailsProcesses(),
      presentation: processPresentation,
      error,
      errorKind,
      loading,
      hasResult,
      refresh: () => data.refresh(),
    };
  });
  const route = () => props.host.destination.page?.details;
  const activePeople = createMemo(() =>
    props.host.open && route()?.kind === "people"
      ? props.bindings?.peopleMentions?.activate
      : undefined,
  );
  // Subpage navigation keeps the host's external close-return target.
  const open = (value: MobileDetailsRoute, title: string) => {
    props.host.navigate({
      area: "details",
      page: {
        key: "id" in value ? `${value.kind}:${value.id}` : value.kind,
        title,
        details: value,
      },
      backTo: props.host.destination,
    });
  };
  const sharing = createChatSessionSharingMobileAdapter(() => props.bindings?.sharing, {
    onOpenSharing: () => open({ kind: "sharing" }, t("chat.sessionSharing.sharingOptions")),
    onOpenAccess: () => open({ kind: "session-access" }, t("chat.sessionSharing.sessionAccess")),
    onApplied: () => props.host.back(),
    accessTarget: () =>
      props.presented && route()?.kind === "session-access" ? props.host.destination : undefined,
  });
  const sharingTarget = createMemo(() =>
    props.presented && (route()?.kind === "sharing" || route()?.kind === "session-access")
      ? props.host.destination
      : undefined,
  );
  const inventory = createSessionAutomationInventory(
    {
      get gateway() {
        return context?.gateway;
      },
      get sessionKey() {
        return scopedSessionArtifactKey(
          props.details.sessionKey,
          props.details.currentAgentId ?? undefined,
        );
      },
      get presented() {
        return props.presented;
      },
    },
    () => nativeHost,
  );
  const openAutomation = (jobId: string) =>
    context?.navigate("cron", { search: `?${new URLSearchParams({ job: jobId })}` });
  // Native bridge inputs revoke old callbacks before Solid commits the next frame.
  const capturePresentation = () => {
    const details = props.details;
    const host = props.host;
    const destination = host.destination;
    const scopeKey = host.scopeKey;
    const sameIdentity = () =>
      nativeHost.isConnected &&
      nativeHost.details === details &&
      nativeHost.host === host &&
      props.host === host &&
      host.scopeKey === scopeKey &&
      host.destination === destination;
    return {
      host,
      destination,
      sameIdentity,
      current: () =>
        sameIdentity() && nativeHost.presented && props.presented && host.open && !host.suspended,
    };
  };
  function Contributions(input: {
    kind: "session-mobile-root" | "session-mobile-page";
    presented: boolean;
  }) {
    const selected = () => {
      const page = route();
      return page?.kind === "contribution" ? page : undefined;
    };
    const facts = createMemo(() => {
      const owner = capturePresentation();
      const value = props.details.sessionHeaderFacts;
      return (
        value && {
          ...value,
          readCurrent: () =>
            owner.sameIdentity() ? (value.readCurrent ? value.readCurrent() : value) : undefined,
        }
      );
    });
    return (
      <Show when={context}>
        <PluginContributions
          kind={input.kind}
          sessionKey={props.details.sessionKey}
          agentId={props.details.currentAgentId}
          facts={facts()}
          presented={input.presented}
          detailsPage={selected()}
          onOpenDetailsPage={((owner) => (pluginId, page, source) => {
            if (owner.current()) {
              owner.host.navigate(
                {
                  area: "details",
                  page: {
                    key: `${pluginId}:${page.id}`,
                    title: page.title,
                    details: { kind: "contribution", pluginId, id: page.id },
                  },
                  backTo: owner.destination,
                },
                source,
              );
            }
          })(capturePresentation())}
          onDetailsBack={((owner) => () => {
            if (owner.current()) {
              owner.host.back();
            }
          })(capturePresentation())}
          onOpenSessionDiff={props.details.onOpenSessionDiff}
        />
      </Show>
    );
  }
  const peoplePreview = createMemo(() => {
    const people = props.bindings?.people;
    // The native projection already deduplicates creator, owner and participants.
    const members = people
      ? [people.creator, people.owner, ...people.participants].filter(
          (person) => person !== undefined,
        )
      : [];
    const total = members.length + (people?.unlistedParticipantCount ?? 0);
    const visible = members.slice(0, total > 4 ? 3 : 4);
    return { visible, overflow: total - visible.length };
  });
  // The root entry survives route/detail snapshots. Creating it inside root's
  // memo would dispose the plugin watch before the destination view adopts it.
  const rootContributions = (
    <Contributions kind="session-mobile-root" presented={props.presented && !route()} />
  );
  const root = createMemo<ChatDetailsMobilePage>(() => ({
    kind: "root",
    content: {
      entries: {
        contributions: rootContributions,
        labels: {
          people: t("chat.mobileDetails.people"),
          taskProgress: t("sessionProgressCard.composerTitle"),
          subagents: t("chat.sessionDetails.subagents"),
          environment: t("chat.sessionDetails.environment"),
          context: t("chat.sessionDetails.context"),
          automations: t("chat.sessionDetails.automations"),
          generatedFiles: t("chat.mobileDetails.generatedFiles"),
          session: t("chat.sessionDetails.session"),
        },
        people: props.bindings?.people
          ? {
              label: t("chat.sessionHeader.people"),
              metadata: (
                <span class="chat-details-mobile-root__avatars">
                  <For each={peoplePreview().visible}>
                    {(person) => (
                      <span class="chat-details-mobile-root__avatar">
                        <ChatAuthorAvatar sender={person.sender} hideTooltip />
                      </span>
                    )}
                  </For>
                  <Show when={peoplePreview().overflow > 0}>
                    <span
                      class="chat-details-mobile-root__people-overflow"
                      role="img"
                      aria-label={t("chat.sessionHeader.morePeople", {
                        count: String(peoplePreview().overflow),
                      })}
                    >
                      +{peoplePreview().overflow}
                    </span>
                  </Show>
                </span>
              ),
            }
          : undefined,
        versions: props.bindings?.versions
          ? {
              label: t("chat.sessionHeader.branches"),
              metadata:
                props.bindings.versions.query.status === "ready" ||
                props.bindings.versions.branches.length > 0
                  ? props.bindings.versions.branches.length
                  : undefined,
            }
          : undefined,
        onNavigate: (destination) => {
          switch (destination.kind) {
            case "people":
              open(destination, t("chat.sessionHeader.people"));
              break;
            case "outputs":
              open(destination, t("chat.mobileDetails.outputs"));
              break;
            case "automations":
              open(destination, t("chat.sessionDetails.automations"));
              break;
            case "automation":
              openAutomation(destination.jobId);
              break;
            case "task-progress":
              open(destination, t("sessionProgressCard.composerTitle"));
              break;
            case "versions":
              open(destination, t("chat.sessionHeader.branches"));
              break;
            case "subagents":
              props.details.onOpenSubagents?.();
              break;
            case "subagent":
              props.details.onOpenSubagent?.(destination.sessionKey);
              break;
          }
        },
      },
      sharing,
      outputs: { label: t("chat.mobileDetails.outputs") },
      automations: { inventory, summary: { label: t("chat.sessionDetails.automations") } },
      processes: processData(),
      subagents: {
        workingLabel: t("chat.subagentsPanel.desktopWorking"),
        onOpenSubagent: (key) => {
          const listed = props.details.subagentSessions?.some((session) => session.key === key);
          if (listed) {
            props.details.onOpenSubagent?.(key);
          } else {
            props.details.onSessionSelect?.(key);
          }
        },
        onOpenSubagents: () => props.details.onOpenSubagents?.(),
      },
    },
  }));
  const pages = createMemo<ChatDetailsMobilePage[]>(() => {
    const result: ChatDetailsMobilePage[] = [
      root(),
      { kind: "sharing", content: sharing },
      { kind: "session-access", content: sharing },
      { kind: "outputs" },
      {
        kind: "automations",
        content: {
          inventory,
          basePath: context?.basePath ?? "",
          onOpenAutomation: openAutomation,
        },
      },
    ];
    if (props.bindings?.people) {
      result.push({
        kind: "people",
        content: {
          people: props.bindings.people,
          onMention: (person) => {
            if (props.bindings?.peopleMentions?.insert(person.profileId)) {
              props.host.close();
            }
          },
          sharing,
          labels: {
            people: t("chat.sessionHeader.people"),
            viewingNow: t("presence.card.viewingNow"),
            creator: t("chat.sessionSharing.creator"),
            owner: t("chat.sessionSharing.owner"),
            participants: t("chat.sessionHeader.peopleParticipants"),
            mention: t("chat.sessionHeader.mention"),
            mentionPerson: (name) => t("chat.sessionHeader.mentionPerson", { name }),
            morePeople: (count) => t("chat.sessionHeader.morePeople", { count: String(count) }),
          },
        },
      });
    }
    if (props.details.onShowTaskProgressChange) {
      result.push({
        kind: "task-progress",
        content: {
          showTaskProgress: props.details.showTaskProgress !== false,
          onShowTaskProgressChange: props.details.onShowTaskProgressChange,
        },
      });
    }
    if (props.bindings?.goal) {
      result.push({ kind: "goal", content: props.bindings.goal });
    }
    if (props.bindings?.versions) {
      result.push({ kind: "versions", content: props.bindings.versions });
    }
    return result;
  });
  return (
    <>
      {inventory.lifecycle}
      <Show when={activePeople()} keyed>
        {(activate) => {
          onSettled(activate);
          return null;
        }}
      </Show>
      <Show when={sharingTarget()} keyed>
        {(_destination) => {
          onSettled(() => sharing.prepare());
          return null;
        }}
      </Show>
      <div
        class="chat-mobile-details-page"
        hidden={route()?.kind !== "contribution"}
        inert={!props.presented || route()?.kind !== "contribution"}
        data-details-page="contribution"
      >
        <div
          class="chat-mobile-details-page__body"
          ref={[elementRef(props.details.onScrollPortRef)]}
        >
          <Contributions
            kind="session-mobile-page"
            presented={props.presented && route()?.kind === "contribution"}
          />
        </div>
      </div>
      <For each={pages()} keyed={(page) => page.kind}>
        {(page) => {
          const visible = () => props.presented && (route()?.kind ?? "root") === page().kind;
          const [scrollport, setScrollport] = createSignal<HTMLDivElement>();
          createScrollPosition(() => {
            const owner = processes();
            return {
              retain:
                page().kind === "root"
                  ? {
                      identity: [props.host.scopeKey, page().kind],
                      target: scrollport(),
                      presented: visible(),
                      ready: isProcessesPresentationReady(owner, gateway?.read().snapshot),
                    }
                  : undefined,
            };
          });
          return (
            <ContentPresentation value={visible}>
              <div
                class="chat-mobile-details-page"
                hidden={!visible()}
                inert={!visible()}
                data-details-page={page().kind}
              >
                <div
                  class="chat-mobile-details-page__body"
                  ref={[setScrollport, elementRef(props.details.onScrollPortRef)]}
                >
                  <Show when={page().kind === "people"}>
                    <Show when={props.bindings?.peopleMentions?.status === "loading"}>
                      <PanelLoadingSkeleton
                        variant="file-list"
                        label={t("common.loading")}
                        compact
                      />
                    </Show>
                    <Show
                      when={["error", "unavailable", "insert-rejected"].includes(
                        props.bindings?.peopleMentions?.status ?? "",
                      )}
                    >
                      <p role="alert">
                        {props.bindings?.peopleMentions?.status === "insert-rejected"
                          ? t("chat.sessionHeader.mentionRejected")
                          : (props.bindings?.peopleMentions?.error ??
                            t("chat.mentions.unavailable"))}
                        <button
                          type="button"
                          class="btn btn--ghost"
                          onClick={() => void props.bindings?.peopleMentions?.request()}
                        >
                          {t("common.retry")}
                        </button>
                      </p>
                    </Show>
                    <Show when={props.bindings?.peopleMentions?.truncated}>
                      <p role="status">{t("chat.sessionHeader.mentionsTruncated")}</p>
                    </Show>
                  </Show>
                  <ChatDetailsMobileContent
                    details={props.details}
                    presented={visible()}
                    page={page()}
                  />
                </div>
                <ChatDetailsMobileControls
                  details={props.details}
                  presented={visible()}
                  page={page()}
                />
              </div>
            </ContentPresentation>
          );
        }}
      </For>
    </>
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-mobile-host-content": ChatDetailsMobileHostContent;
  }
}
