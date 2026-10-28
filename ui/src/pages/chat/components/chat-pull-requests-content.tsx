import { createMemo, For, Show, useContext } from "solid-js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import "../../../components/tooltip.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { sessionPullRequestStateIcons } from "../../../lib/session-pull-request-presentation.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { HoverMarquee } from "../../../lib/solid/hover-marquee.tsx";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { ChatCiAutomationPanel, ChatCiDetailsPanel } from "./chat-ci-panels.tsx";
import { GitHubPublicationAction, GitHubPublicationDetails } from "./chat-github-publication.tsx";
import { PullRequestActions } from "./chat-pull-request-actions.tsx";
import { ChatPullRequestChecks } from "./chat-pull-request-checks.tsx";
import { chatPullRequestRows, type PullRequestRowEntry } from "./chat-pull-request-rows.ts";
import {
  ChecksRows,
  StatusWarning,
  STATE_LABEL_KEYS,
  type ChatPullRequestsProps,
} from "./chat-pull-request-shared.tsx";
import { hasChatPullRequests, retainedPublication, showWorkRow } from "./chat-pull-requests.ts";
import "./chat-pull-request-presenters.css";

registerGitHubEnglish();

const CHECK_LABEL_KEYS = {
  passing: "chat.pullRequests.checksPassing",
  failing: "chat.pullRequests.checksFailing",
  pending: "chat.pullRequests.checksPending",
} as const;

function Checks(props: {
  pullRequest: ControlUiSessionPullRequest;
  gateway?: ApplicationGateway;
  sessionKey?: string;
  sessionId?: string;
  presented?: PresentationValue;
  dismissed?: boolean;
}) {
  const checks = () => props.pullRequest.checks;
  const label = () => {
    const current = checks();
    return current ? t(CHECK_LABEL_KEYS[current.state]) : t("chat.pullRequests.ciMonitoring");
  };
  const parentPresented = useContext(ContentPresentation);
  const presentation = createMemo(() => projectPresentation(props.presented ?? true));
  const presented = () => parentPresented() && presentation().read();
  const content = () => (
    <>
      <div class="chat-pr__checks-menu-header">
        <span>{t("chat.pullRequests.ciMonitoring")}</span>
        <Show when={props.pullRequest.checksUrl}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("chat.pullRequests.openChecks")}
            >
              <Icon name="externalLink" />
            </a>
          )}
        </Show>
      </div>
      <div class="chat-pr__checks-counts">
        <ChecksRows checks={checks()} />
        <Show when={!checks()}>{t("chat.pullRequests.automationNoChecks")}</Show>
      </div>
      <ChatCiAutomationPanel
        pullRequest={props.pullRequest}
        gateway={props.gateway}
        sessionKey={props.sessionKey ?? ""}
        sessionId={props.sessionId ?? ""}
        presented={presented()}
      />
      <Show when={checks()}>
        <ChatCiDetailsPanel
          pullRequest={props.pullRequest}
          gateway={props.gateway}
          sessionKey={props.sessionKey ?? ""}
          presented={presented()}
        />
      </Show>
    </>
  );
  return (
    <ChatPullRequestChecks
      label={label()}
      checksState={checks()?.state ?? "none"}
      presented={presented()}
      dismissed={props.dismissed}
    >
      {content}
    </ChatPullRequestChecks>
  );
}

export function ChatPullRequestsContent(props: ChatPullRequestsProps) {
  const published = () =>
    props.publication?.result?.status === "published" ? props.publication.result : undefined;
  const retained = () => retainedPublication(props.publication);
  const visibleBranch = () =>
    props.publishedOnly || props.branchDismissed || props.publication?.provider === "gitlab"
      ? undefined
      : props.branch;
  const workRow = () => !props.publishedOnly && showWorkRow(props);
  const visible = createMemo(() => chatPullRequestRows(props));
  const recovery = () =>
    !props.publishedOnly && retained() && (!published() || props.publication?.error)
      ? props.publication
      : undefined;
  function WorkRow(childProps: { branch?: ControlUiSessionBranch }) {
    const workPublished = () =>
      !childProps.branch && props.publication?.result?.status === "published"
        ? props.publication.result
        : undefined;
    return (
      <article
        class="chat-pr"
        data-state={workPublished() ? "published" : childProps.branch ? "branch" : "publication"}
      >
        <span class="chat-pr__link chat-pr__link--static">
          <span class="chat-pr__icon" aria-hidden="true">
            <Icon name={workPublished() || !childProps.branch ? "gitPullRequest" : "gitBranch"} />
          </span>
          <span class="chat-pr__identity">
            <span class="chat-pr__repo">
              {workPublished()?.repository ??
                props.publication?.target?.repository ??
                childProps.branch?.repo ??
                t(
                  props.publication?.provider === "gitlab"
                    ? "githubPublication.title"
                    : "chat.pullRequests.publishPr",
                )}
            </span>
            <span class="chat-pr__branch">
              {workPublished()?.branch ??
                props.publication?.target?.branch ??
                childProps.branch?.branch}
            </span>
          </span>
        </span>
        <span class="chat-pr__meta">
          <Show when={!workPublished() ? childProps.branch : undefined}>
            {(branch) => (
              <SessionGitDiff
                classPrefix="chat-pr"
                item={branch()}
                onOpen={props.onOpenSessionDiff}
              />
            )}
          </Show>
          <Show when={props.publication?.provider !== "gitlab"}>
            <StatusWarning status={props.status} />
          </Show>
          <Show
            when={props.publication}
            fallback={
              <Show when={childProps.branch?.createUrl}>
                {(url) => (
                  <a
                    class="chat-pr__create"
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("chat.pullRequests.createPrLabel", {
                      label: t("chat.pullRequests.createPr"),
                      branch: childProps.branch?.branch ?? "",
                    })}
                  >
                    {t("chat.pullRequests.createPr")}
                  </a>
                )}
              </Show>
            }
          >
            {(publication) => (
              <GitHubPublicationAction publication={publication()} presented={props.presented} />
            )}
          </Show>
          <Show when={childProps.branch && !workPublished() && props.onDismissBranch}>
            <button
              class="chat-pr__dismiss"
              type="button"
              disabled={props.publication?.activity != null}
              aria-label={t("chat.pullRequests.dismissBranch", {
                branch: childProps.branch?.branch ?? "",
              })}
              onClick={() => {
                if (childProps.branch) {
                  props.onDismissBranch?.(childProps.branch);
                }
              }}
            >
              <Icon name="x" />
            </button>
          </Show>
        </span>
        <Show when={props.publication}>
          {(publication) => <GitHubPublicationDetails publication={publication()} />}
        </Show>
      </article>
    );
  }

  return (
    <Show when={hasChatPullRequests(props)}>
      <div class="chat-prs" aria-live="polite">
        <Show
          when={workRow()}
          fallback={
            <>
              <For each={visible()} keyed={(entry) => entry.url}>
                {(pullRequest) => (
                  <PullRequestRow
                    entry={pullRequest()}
                    owner={props}
                    published={published()?.url === pullRequest().url}
                  />
                )}
              </For>
              <Show when={recovery()}>
                {(publication) => (
                  <PublicationRecovery publication={publication()} presented={props.presented} />
                )}
              </Show>
            </>
          }
        >
          <WorkRow branch={visibleBranch()} />
        </Show>
      </div>
    </Show>
  );
}

function PullRequestRow(props: {
  entry: PullRequestRowEntry;
  owner: ChatPullRequestsProps;
  published: boolean;
}) {
  const details = () => props.entry.details;
  let row: HTMLElement | undefined;
  const dismissLabel = () => t("chat.pullRequests.dismiss", { reference: props.entry.reference });
  const disabled = () => props.published && props.owner.publication?.activity !== null;
  const dismiss = () => {
    if (props.published) {
      void props.owner.publication?.onNewAction?.();
    }
    const pullRequest = details();
    if (pullRequest) {
      props.owner.onDismiss(pullRequest);
    }
  };
  const badge = () => {
    const checks = details()?.checks;
    if (props.owner.status !== "ready" || !checks) {
      return undefined;
    }
    return checks.failed > 0
      ? "failed"
      : checks.running > 0
        ? "running"
        : checks.passed > 0
          ? "passed"
          : undefined;
  };
  return (
    <article
      ref={(element) => (row = element)}
      class={["chat-pr", { "chat-pr--compact chat-pr--summary": props.owner.compact }]}
      data-state={details()?.state ?? "published"}
    >
      <a
        class="chat-pr__link"
        data-link-reader-preview={props.owner.compact ? "off" : undefined}
        href={props.entry.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={
          details()
            ? t("chat.pullRequests.linkLabel", {
                reference: props.entry.reference,
                title: details()!.title,
              })
            : `${t("chat.pullRequests.openPublishedPr")}: ${props.entry.reference} · ${props.entry.branch}`
        }
      >
        <span class="chat-pr__icon" aria-hidden="true">
          <Icon
            name={details() ? sessionPullRequestStateIcons[details()!.state] : "gitPullRequest"}
          />
          <Show when={props.owner.compact && badge()}>
            {(state) => (
              <span class={["chat-pr__badge", `chat-pr__badge--${state()}`]}>
                <Show when={state() !== "running"} fallback={<span class="btn__spinner" />}>
                  <Icon name={state() === "failed" ? "x" : "check"} />
                </Show>
              </span>
            )}
          </Show>
        </span>
        <Show when={!props.owner.compact}>
          <span class="chat-pr__number">{props.entry.reference}</span>
        </Show>
        <span class="chat-pr__identity">
          <Show
            when={props.owner.compact}
            fallback={
              <span ref={createTextOverflow(() => props.entry.branch)} class="chat-pr__branch">
                {props.entry.branch}
              </span>
            }
          >
            <HoverMarquee
              class="chat-pr__title"
              content={details()?.title ?? `${props.entry.reference} · ${props.entry.branch}`}
              options={{
                host: () => (row?.closest(".chat-details[data-desktop]") ? row : undefined),
                stationaryWithoutHost: true,
              }}
            />
          </Show>
        </span>
      </a>
      <Show
        when={props.owner.compact}
        fallback={
          <Show when={details()}>
            {(pullRequest) => (
              <span class="chat-pr__meta">
                <SessionGitDiff classPrefix="chat-pr" item={pullRequest()} />
                <Checks
                  pullRequest={pullRequest()}
                  gateway={props.owner.gateway}
                  sessionKey={props.owner.sessionKey}
                  sessionId={props.owner.sessionId}
                  presented={props.owner.presented}
                  dismissed={props.owner.dismissed}
                />
                <Show when={pullRequest().state !== "open"}>
                  <span class="chat-pr__state">{t(STATE_LABEL_KEYS[pullRequest().state])}</span>
                </Show>
                <Show
                  when={pullRequest().state !== "merged" || props.owner.status === "unavailable"}
                >
                  <StatusWarning status={props.owner.status} />
                </Show>
                <button
                  class="chat-pr__dismiss"
                  type="button"
                  disabled={disabled()}
                  aria-label={dismissLabel()}
                  onClick={dismiss}
                >
                  <Icon name="x" />
                </button>
              </span>
            )}
          </Show>
        }
      >
        <PullRequestActions
          label={t("chat.pullRequests.actions", { reference: props.entry.reference })}
          disabled={disabled()}
          presented={props.owner.presented ?? true}
          dismissed={props.owner.dismissed}
          onDismiss={dismiss}
          url={props.entry.url}
          pullRequest={details()}
          owner={props.owner}
        />
      </Show>
    </article>
  );
}

function PublicationRecovery(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
}) {
  const failed = () => props.publication.result?.status === "failed";
  const content = () => (
    <div class="chat-pr__publication-recovery">
      <GitHubPublicationDetails publication={props.publication} inline={failed()} />
      <Show when={props.publication.result?.status !== "published"}>
        <div>
          <GitHubPublicationAction publication={props.publication} presented={props.presented} />
        </div>
      </Show>
    </div>
  );
  // A session receipt has no proven relationship to any listed PR.
  return (
    <Show when={failed()} fallback={content()}>
      <details class="chat-pr__publication-history">
        <summary>{t("githubPublication.failedAttempt")}</summary>
        {content()}
      </details>
    </Show>
  );
}
