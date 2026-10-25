import { Match, Show, Switch, createMemo, isPending, lazy, onSettled } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { StepMarker } from "../../../components/session-progress-card-content.tsx";
import {
  progressCardNoteSummary,
  progressCardPresentation,
} from "../../../components/session-progress-card.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listSubagents } from "../chat-subagent-wait.ts";
import {
  SessionAutomationMobileList,
  type SessionAutomationMobileListProps,
} from "./chat-automation-mobile.tsx";
import { ChatDetailsEnvironmentMobile } from "./chat-details-environment-mobile.tsx";
import { ChatDetailsGoal, type ChatDetailsGoalProps } from "./chat-details-goal.tsx";
import {
  ChatDetailsMobileProcesses,
  type ChatDetailsMobileProcessesProps,
} from "./chat-details-mobile-processes.tsx";
import {
  ChatDetailsMobileRoot,
  type ChatDetailsMobileEntry,
  type ChatDetailsMobileRootProps,
} from "./chat-details-mobile-root.tsx";
import {
  MobileTaskProgressContent,
  MobileTaskProgressControls,
  type MobileTaskProgressProps,
} from "./chat-details-progress.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import type { GitHubPublicationMobileProps } from "./chat-github-publication-mobile.tsx";
import "../../../styles/chat/github-publication-mobile.css";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ChatMobilePeopleBody, type ChatMobilePeopleBodyProps } from "./chat-mobile-people.tsx";
import { ChatOutputsMobile, getChatOutputsCount } from "./chat-outputs.tsx";
import {
  ChatPullRequestMobileCollection,
  ChatPullRequestMobileDetail,
  ChatPullRequestMobileChecks,
  ChatPullRequestMobileMonitoring,
  type ChatPullRequestMobileCiProps,
  type ChatPullRequestMobileCollectionProps,
  type ChatPullRequestMobileDetailProps,
} from "./chat-pull-request-mobile.tsx";
import type { ChatSessionSharingMobileAdapter } from "./chat-session-sharing-mobile-adapter.tsx";
import {
  ChatSessionAccessMobile,
  ChatSessionSharingMobile,
} from "./chat-session-sharing-mobile.tsx";
import { ChatSessionSharingOptions } from "./chat-session-sharing-options.tsx";
import {
  ChatSessionVersionsMobile,
  type ChatSessionVersionsMobileProps,
} from "./chat-session-versions-mobile.tsx";
import {
  SessionAutomationRead,
  type SessionAutomationInventory,
} from "./chat-summary-automations.tsx";
import "../../../styles/chat/details.css";
import { SessionAutomationResult } from "./session-automation-result.tsx";
import { createSessionAutomationSchedule } from "./session-automation-schedule-loader.ts";

registerEnglishCatalog(registerChatSessionEnglish);

const GitHubPublicationMobile = lazy(() => import("./chat-github-publication-mobile.tsx"), {
  export: "GitHubPublicationMobile",
});

type ChatDetailsMobileRegionProps = {
  details: ChatDetailsProps;
  presented: boolean;
};

type ChatDetailsMobileRootContent = {
  /** Labels and navigation belong to the host; native facts are projected below. */
  entries: Omit<
    ChatDetailsMobileRootProps,
    | "presented"
    | "environment"
    | "outputs"
    | "sharingOptions"
    | "publication"
    | "publicationEntry"
    | "context"
    | "processes"
    | "subagents"
    | "taskProgress"
    | "taskProgressNotice"
    | "automations"
  >;
  /** Labels only; facts/actions/demand come from the native details.outputs binding. */
  outputs?: { label: string };
  /** The native Sharing adapter, constructed under the retained session host. */
  sharing?: ChatSessionSharingMobileAdapter;
  /** The publication owner supplies the review entry, including retained publication/recovery states. */
  publicationEntry?: ChatDetailsMobileEntry;
  processes: ChatDetailsMobileProcessesProps["data"] | undefined;
  /** Keep every native child; the host routes unlisted children through onSessionSelect. */
  subagents: Omit<NonNullable<ChatDetailsMobileRootProps["subagents"]>, "rows">;
  /** One session-owned inventory, shared with desktop; never construct it in the opener. */
  automations?: { inventory: SessionAutomationInventory; summary: ChatDetailsMobileEntry };
};

type ChatDetailsMobileProgressPreference = Pick<
  MobileTaskProgressProps,
  "showTaskProgress" | "onShowTaskProgressChange"
>;

type ChatDetailsMobilePeopleContent = Omit<ChatMobilePeopleBodyProps, "sharingOptions"> & {
  sharing?: ChatSessionSharingMobileAdapter;
};

/** Only supplied mobile bodies belong here. Missing peer bodies stay with their owners. */
export type ChatDetailsMobilePage =
  | { kind: "root"; content: ChatDetailsMobileRootContent }
  | { kind: "people"; content: ChatDetailsMobilePeopleContent }
  | { kind: "task-progress"; content: ChatDetailsMobileProgressPreference }
  | { kind: "pull-requests"; content: ChatPullRequestMobileCollectionProps }
  | { kind: "pull-request"; content: ChatPullRequestMobileDetailProps }
  | {
      kind: "pull-request-checks" | "pull-request-monitoring";
      content: Omit<ChatPullRequestMobileCiProps, "presented">;
    }
  | { kind: "versions"; content: ChatSessionVersionsMobileProps }
  | { kind: "outputs" }
  | { kind: "automations"; content: SessionAutomationMobileListProps }
  | { kind: "sharing"; content: ChatSessionSharingMobileAdapter }
  | { kind: "session-access"; content: ChatSessionSharingMobileAdapter }
  | {
      kind: "goal";
      /** Native composer admission/recovery/actions; the goal comes from selectedSession. */
      content: Omit<ChatDetailsGoalProps, "goal" | "presented">;
    }
  | {
      kind: "publication";
      /** publication is the live Details binding, retained independently of its opener. */
      content: Omit<GitHubPublicationMobileProps, "presented" | "branch">;
    };

export type ChatDetailsMobileContentProps = ChatDetailsMobileRegionProps & {
  /** The host owns destination identity, ancestry, retention and presentation. */
  page: ChatDetailsMobilePage;
};

function MobileRoot(
  props: ChatDetailsMobileRegionProps & { content: ChatDetailsMobileRootContent },
) {
  const formatSchedule = createSessionAutomationSchedule();
  const outputs = (): ChatDetailsMobileEntry | undefined => {
    const data = props.details.outputs;
    if (!data) {
      return undefined;
    }
    const count = getChatOutputsCount(data);
    return {
      label: props.content.outputs?.label ?? props.content.entries.labels.generatedFiles,
      metadata: count === null ? undefined : count,
    };
  };
  const progress = createMemo(() => {
    const card = props.details.progressCard;
    return card
      ? progressCardPresentation(
          card,
          props.details.selectedSession?.status,
          props.details.selectedSession?.startedAt,
          props.details.selectedSession?.endedAt,
          props.details.runActive,
        )
      : undefined;
  });
  const progressNote = createMemo(() => {
    const markdown = props.details.progressCard?.markdown;
    if (progress()?.counts || !markdown) {
      return "";
    }
    // Use the full note's parser/sanitizer; the compact preview omits its bars.
    return progressCardNoteSummary(
      toSanitizedMarkdownHtml(markdown, {
        progressBars: true,
        codeBlockChrome: "none",
      }),
    );
  });
  const automationNotice = (
    <Show when={props.content.automations}>
      {(input) => (
        <SessionAutomationRead
          inventory={input().inventory}
          readDeniedOnly
          error={
            input().inventory.connected() && (
              <div class="chat-details-mobile-root__notice" role="status">
                <span>
                  {t(
                    input().inventory.loaded()
                      ? "chat.sessionDetails.automationUpdateError"
                      : "chat.sessionDetails.automationError",
                  )}
                </span>
                <button
                  type="button"
                  class="chip"
                  disabled={!props.presented || isPending(input().inventory.read)}
                  onClick={() => void input().inventory.refresh()}
                >
                  {t("common.retry")}
                </button>
              </div>
            )
          }
        />
      )}
    </Show>
  );
  const automations = (): ChatDetailsMobileRootProps["automations"] => {
    const input = props.content.automations;
    if (!input) {
      return undefined;
    }
    const inventory = input.inventory;
    return {
      items: inventory.jobs().map((job) => ({
        value: job.id,
        label: job.name.trim() || job.id,
        status: <SessionAutomationResult job={job} />,
        // Keep asynchronous schedule reads inside the rendered automations section.
        get description() {
          return job.autoDisabled
            ? t("chat.sessionDetails.automationAttention")
            : !job.enabled
              ? t("chat.sessionDetails.automationPaused")
              : inventory.connected() && job.runningAtMs !== undefined
                ? t("common.running")
                : job.schedule
                  ? formatSchedule(job.schedule)
                  : undefined;
        },
      })),
      total: inventory.loaded() ? inventory.total() : undefined,
      summary: input.summary,
      notice: automationNotice,
    };
  };
  return (
    <ChatDetailsMobileRoot
      {...props.content.entries}
      presented={props.presented}
      taskProgress={
        progress()?.counts || progressNote()
          ? {
              label: (progress()?.counts ? progress()?.stepLabel : undefined) ?? progressNote(),
              truncateDescription: !progress()?.counts,
              leading: progress()?.counts ? (
                <span
                  class="chat-details-mobile-root__step-marker"
                  data-status={progress()?.presentedCurrentStatus}
                  aria-hidden="true"
                >
                  <StepMarker
                    status={progress()?.presentedCurrentStatus ?? "pending"}
                    outcome={progress()?.terminalOutcome}
                  />
                </span>
              ) : undefined,
              metadata: progress()?.counts
                ? `${progress()?.currentPosition} / ${progress()?.counts?.total}`
                : undefined,
            }
          : undefined
      }
      taskProgressNotice={
        props.details.progressCardError === "access-denied" ? (
          <div class="chat-details-mobile-root__notice" role="status">
            {t("sessionProgressCard.widgetAccessDenied")}
          </div>
        ) : undefined
      }
      subagents={{ ...props.content.subagents, rows: listSubagents(props.details) }}
      automations={automations()}
      environment={
        <ChatDetailsEnvironmentMobile
          {...props.details.environment}
          details={props.details}
          presented={props.presented}
        />
      }
      outputs={outputs()}
      sharingOptions={
        props.content.sharing?.available ? (
          <ChatSessionSharingOptions {...props.content.sharing.options} />
        ) : undefined
      }
      publicationEntry={
        props.details.githubPublication ? props.content.publicationEntry : undefined
      }
      processes={
        props.content.processes ? (
          <ChatDetailsMobileProcesses
            data={props.content.processes}
            presented={props.presented}
            onOpen={props.details.onOpenProcesses}
          />
        ) : undefined
      }
    />
  );
}

/**
 * Mount in the session-scoped mobile host. To retain a page, keep its instance
 * mounted with presented=false and the host hidden/inert; no route store lives here.
 * The host also owns insets/scroll (Goal exposes its own body through onScrollPortRef).
 */
export function ChatDetailsMobileContent(props: ChatDetailsMobileContentProps) {
  // The native retain function changes only with resource identity, not catalog publications.
  const outputsDemand = createMemo(() =>
    props.presented &&
    (props.page.kind === "root" || props.page.kind === "outputs") &&
    props.details.outputs
      ? props.details.retainOutputs
      : undefined,
  );
  return [
    <Show when={outputsDemand()} keyed>
      {(retain) => {
        onSettled(retain);
        return null;
      }}
    </Show>,
    <Switch>
      <Match when={props.page.kind === "root" && props.page}>
        {(page) => (
          <MobileRoot
            details={props.details}
            presented={props.presented}
            content={page().content}
          />
        )}
      </Match>
      <Match when={props.page.kind === "people" && props.page}>
        {(page) => (
          <ChatMobilePeopleBody
            {...page().content}
            sharingOptions={
              <Show when={page().content.sharing?.available && page().content.sharing}>
                {(sharing) => <ChatSessionSharingOptions {...sharing().options} />}
              </Show>
            }
          />
        )}
      </Match>
      <Match when={props.page.kind === "task-progress" && props.page}>
        {(page) => (
          <MobileTaskProgressContent
            {...mobileProgressProps(props.details, props.presented, page().content)}
          />
        )}
      </Match>
      <Match when={props.page.kind === "pull-requests" && props.page}>
        {(page) => <ChatPullRequestMobileCollection {...page().content} />}
      </Match>
      <Match when={props.page.kind === "pull-request" && props.page}>
        {(page) => <ChatPullRequestMobileDetail {...page().content} />}
      </Match>
      <Match when={props.page.kind === "pull-request-checks" && props.page}>
        {(page) => <ChatPullRequestMobileChecks {...page().content} presented={props.presented} />}
      </Match>
      <Match when={props.page.kind === "pull-request-monitoring" && props.page}>
        {(page) => (
          <ChatPullRequestMobileMonitoring {...page().content} presented={props.presented} />
        )}
      </Match>
      <Match when={props.page.kind === "versions" && props.page}>
        {(page) => <ChatSessionVersionsMobile {...page().content} />}
      </Match>
      <Match when={props.page.kind === "outputs"}>
        <Show when={props.details.outputs}>
          {(outputs) => <ChatOutputsMobile {...outputs()} />}
        </Show>
      </Match>
      <Match when={props.page.kind === "automations" && props.page}>
        {(page) => <SessionAutomationMobileList {...page().content} />}
      </Match>
      <Match when={props.page.kind === "sharing" && props.page}>
        {(page) => <ChatSessionSharingMobile {...page().content.sharing} />}
      </Match>
      <Match when={props.page.kind === "session-access" && props.page}>
        {(page) => <ChatSessionAccessMobile {...page().content.access} />}
      </Match>
      <Match when={props.page.kind === "goal" && props.page}>
        {(page) => (
          <ChatDetailsGoal
            {...page().content}
            goal={props.details.selectedSession?.goal ?? undefined}
            presented={props.presented}
            onScrollPortRef={props.details.onScrollPortRef}
          />
        )}
      </Match>
      <Match when={props.page.kind === "publication" && props.page}>
        {(page) => (
          <ChatLazyBoundary>
            <GitHubPublicationMobile
              {...page().content}
              branch={props.details.pullRequestsBranch}
              presented={props.presented}
            />
          </ChatLazyBoundary>
        )}
      </Match>
    </Switch>,
  ];
}

function mobileProgressProps(
  details: ChatDetailsProps,
  presented: boolean,
  preference: ChatDetailsMobileProgressPreference,
): MobileTaskProgressProps {
  return {
    ...preference,
    card: details.progressCard,
    initialLoading: details.progressCardInitialLoading === true,
    error: details.progressCardError,
    presented,
    refreshAction: details.progressCardRefresh,
    onClearSavedProgressCard: details.onClearSavedProgressCard,
    sessionStatus: details.selectedSession?.status,
    startedAt: details.selectedSession?.startedAt,
    endedAt: details.selectedSession?.endedAt,
    hasActiveRun: details.runActive,
  };
}

/** The mobile host mounts this sibling outside its body scroll mask, under the same retained page owner. */
export function ChatDetailsMobileControls(props: ChatDetailsMobileContentProps) {
  return (
    <Show when={props.page.kind === "task-progress" && props.page}>
      {(page) => (
        <MobileTaskProgressControls
          {...mobileProgressProps(props.details, props.presented, page().content)}
        />
      )}
    </Show>
  );
}
