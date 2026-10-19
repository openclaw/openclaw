import { For, Show, createMemo, createSignal, createEffect, untrack } from "solid-js";
import type { ControlUiSessionPullRequestSnapshot } from "../../../../src/gateway/control-ui-contract.js";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { createMobileAutomationBinding } from "./chat-mobile-automation-binding.ts";
import type { ChatMobileHost, MobileDetailsRoute } from "./chat-mobile-host.ts";
import type { ChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import type { ChatMobilePeople } from "./chat-mobile-people.ts";
import { ChatAuthorAvatar } from "./components/chat-author-avatar-view.tsx";
import { SessionAutomationMobileHeading } from "./components/chat-automation-mobile.tsx";
import type { ChatDetailsGoalProps } from "./components/chat-details-goal.tsx";
import {
  ChatDetailsMobileContent,
  ChatDetailsMobileControls,
  type ChatDetailsMobilePage,
} from "./components/chat-details-mobile-content.tsx";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import { chatPullRequestId } from "./components/chat-pull-requests.ts";
import { syncSessionPanelInputs, useSessionPanel } from "./components/chat-session-panel.tsx";
import { createChatSessionSharingMobileAdapter } from "./components/chat-session-sharing-mobile-adapter.tsx";
import type { PreparedChatSessionSharing } from "./components/chat-session-sharing-shared.tsx";
import type { ChatSessionVersionsMobileProps } from "./components/chat-session-versions-mobile.tsx";
import { createSessionAutomationInventory } from "./components/chat-summary-automations.tsx";
import { ProcessesPanelData } from "./processes-panel-data.ts";

export type MobileDetailsBindings = {
  sharing?: PreparedChatSessionSharing;
  people?: ChatMobilePeople;
  peopleMentions?: ChatMobilePeopleMentions;
  goal: Omit<ChatDetailsGoalProps, "goal" | "presented">;
  versions?: ChatSessionVersionsMobileProps;
  pullRequests?: {
    snapshot: ControlUiSessionPullRequestSnapshot | undefined;
    requestRefresh: () => boolean;
  };
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
    return (
      <Show when={props.details && props.host}>
        <MobileHostContent
          details={props.details!}
          host={props.host!}
          bindings={props.bindings}
          presented={props.presented}
          nativeHost={nativeHost}
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
function MobileHostContent(props: {
  details: ChatDetailsProps;
  host: ChatMobileHost;
  bindings?: MobileDetailsBindings;
  presented: boolean;
  nativeHost: ChatDetailsMobileHostContent;
}) {
  const context = useOptionalApplication();
  // This renderer lives inside one native bridge; its input properties remain synchronous.
  const nativeHost = untrack(() => props.nativeHost);
  const [requested, setRequested] = createSignal<{
    snapshot: ControlUiSessionPullRequestSnapshot | undefined;
  }>();
  const processes = context
    ? useSessionPanel(
        nativeHost,
        () => ({
          sessionKey: nativeHost.details?.sessionKey ?? "",
          agentId: nativeHost.details?.currentAgentId ?? "main",
          presented: nativeHost.presented && Boolean(nativeHost.details?.onOpenProcesses),
        }),
        ProcessesPanelData,
        (identityChanged) => {
          if (identityChanged) {
            setRequested(undefined);
          }
        },
      )
    : () => undefined;
  const processData = createMemo(() => {
    const data = processes();
    if (!data) {
      return undefined;
    }
    const { rows, error, loading } = data.snapshot;
    return { rows, error, loading, refresh: () => data.refresh() };
  });
  const route = () => props.host.destination.page?.details;
  const peopleActive = createMemo(() => props.host.open && route()?.kind === "people");
  createEffect(peopleActive, (active) =>
    active ? untrack(() => props.bindings?.peopleMentions?.activate()) : undefined,
  );
  // Subpage navigation keeps the host's external close-return target.
  const open = (value: MobileDetailsRoute, title: string) => {
    props.host.navigate({
      area: "details",
      page: {
        key: "id" in value ? `${value.kind}:${value.id}` : value.kind,
        title,
        details: value,
        heading:
          value.kind === "automation"
            ? () => (
                <Show when={automation?.body()?.job} fallback={title}>
                  {(job) => <SessionAutomationMobileHeading job={job()} />}
                </Show>
              )
            : undefined,
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
  createEffect(sharingTarget, (destination) => {
    if (destination) {
      sharing.prepare();
    }
  });
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
  const automation = context
    ? createMobileAutomationBinding({
        context,
        jobId: () => {
          const value = route();
          return value?.kind === "automation" || value?.kind === "automation-transcript"
            ? value.id
            : undefined;
        },
        agentId: () => props.details.currentAgentId ?? undefined,
        host: () => props.host.detailsMount,
        presented: () => props.presented,
        onTranscript: () => {
          const value = route();
          if (value?.kind === "automation") {
            open({ kind: "automation-transcript", id: value.id }, t("cron.runEntry.transcript"));
          }
        },
        onTranscriptClose: () => {
          if (route()?.kind === "automation-transcript") {
            props.host.back();
          }
        },
      })
    : undefined;
  let wasTranscript = false;
  createEffect(
    () => route()?.kind === "automation-transcript",
    (visible) => {
      if (!visible && wasTranscript) {
        automation?.closeTranscript();
      }
      wasTranscript = visible;
    },
  );
  const snapshot = () => props.bindings?.pullRequests?.snapshot;
  const recovery = () => ({
    status: snapshot()?.status ?? ("ready" as const),
    hasSnapshot: snapshot() !== undefined,
    retrying: requested() !== undefined && requested()?.snapshot === snapshot(),
    onRetry: () => {
      const before = snapshot();
      if (props.bindings?.pullRequests?.requestRefresh()) {
        setRequested({ snapshot: before });
      }
    },
  });
  const requests = () => ({
    ...recovery(),
    pullRequests: props.details.pullRequests ?? [],
    onOpen: (request: NonNullable<ChatDetailsProps["pullRequests"]>[number]) =>
      open({ kind: "pull-request", id: chatPullRequestId(request) }, request.title),
  });
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
  const root = createMemo<ChatDetailsMobilePage>(() => ({
    kind: "root",
    content: {
      entries: {
        labels: {
          people: t("chat.mobileDetails.people"),
          taskProgress: t("sessionProgressCard.composerTitle"),
          subagents: t("chat.sessionDetails.subagents"),
          processes: t("chat.sessionDetails.processes"),
          environment: t("chat.sessionDetails.environment"),
          context: t("chat.sessionDetails.context"),
          pullRequests: t("sessionHovercard.pullRequests"),
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
        pullRequests: props.bindings?.pullRequests
          ? { ...requests(), summary: { label: t("sessionHovercard.pullRequests") } }
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
            case "context":
              open(destination, t("chat.sessionDetails.context"));
              break;
            case "outputs":
              open(destination, t("chat.mobileDetails.outputs"));
              break;
            case "automations":
              open(destination, t("chat.sessionDetails.automations"));
              break;
            case "automation":
              open(
                { kind: "automation", id: destination.jobId },
                t("chat.sessionAutomation.title"),
              );
              break;
            case "task-progress":
              open(destination, t("sessionProgressCard.composerTitle"));
              break;
            case "versions":
              open(destination, t("chat.sessionHeader.branches"));
              break;
            case "publication":
              open(destination, t("chat.pullRequests.publishPr"));
              break;
            case "pull-requests":
              open(destination, t("sessionHovercard.pullRequests"));
              break;
            case "pull-request":
              requests().onOpen(destination.pullRequest);
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
      publicationEntry: props.details.githubPublication
        ? { label: t("chat.activityPills.publication.review") }
        : undefined,
    },
  }));
  const pages = createMemo<ChatDetailsMobilePage[]>(() => {
    const result: ChatDetailsMobilePage[] = [
      root(),
      { kind: "sharing", content: sharing },
      { kind: "session-access", content: sharing },
      { kind: "outputs" },
      { kind: "context" },
      {
        kind: "automations",
        content: {
          inventory,
          basePath: context?.basePath ?? "",
          onOpenAutomation: (id) =>
            open({ kind: "automation", id }, t("chat.sessionAutomation.title")),
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
    const automationBody = automation?.body();
    if (automationBody) {
      result.push({ kind: "automation", content: automationBody });
    }
    if (automation) {
      result.push({
        kind: "automation-transcript",
        content: { transcript: automation.transcript, revision: automation.revision },
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
    if (props.details.githubPublication) {
      result.push({
        kind: "publication",
        content: { publication: props.details.githubPublication },
      });
    }
    if (props.bindings?.pullRequests) {
      result.push({ kind: "pull-requests", content: requests() });
      const selected = route();
      if (selected?.kind === "pull-request") {
        result.push({
          kind: "pull-request",
          content: {
            ...recovery(),
            pullRequest: props.details.pullRequests?.find(
              (request) => chatPullRequestId(request) === selected.id,
            ),
            onDismiss: (request) => {
              const dismiss = props.details.onDismissPullRequest;
              if (!dismiss) {
                return;
              }
              const host = props.host;
              dismiss(request);
              host.navigate(host.destination.backTo ?? { area: "details" });
            },
            dismissDisabled: !props.details.onDismissPullRequest,
          },
        });
      }
    }
    return result;
  });
  return (
    <>
      <Show
        when={
          props.presented &&
          route()?.kind === "automation" &&
          (!automation?.body() || automation?.error())
        }
      >
        <Show
          when={automation?.error()}
          fallback={<PanelLoadingSkeleton variant="review" label={t("common.loading")} />}
        >
          <div class="callout danger" role="alert">
            <p>{automation?.error()}</p>
            <button type="button" class="btn" onClick={() => automation?.retry()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
      </Show>
      <For each={pages()} keyed={(page) => page.kind}>
        {(page) => {
          const visible = () => props.presented && (route()?.kind ?? "root") === page().kind;
          return (
            <ContentPresentation value={visible}>
              <div
                class="chat-mobile-details-page"
                hidden={!visible()}
                inert={!visible()}
                data-details-page={page().kind}
              >
                <div class="chat-mobile-details-page__body">
                  <Show when={page().kind === "people"}>
                    <Show when={props.bindings?.peopleMentions?.status === "loading"}>
                      <p role="status">{t("common.loading")}</p>
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
