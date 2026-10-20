import { createMemo, createUniqueId, For, Show, useContext } from "solid-js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { formatGitHubItemReference } from "../../../components/github-link-target.ts";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import "../../../components/tooltip.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import {
  orderSessionPullRequests,
  sessionPullRequestStateIcons,
} from "../../../lib/session-pull-request-presentation.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { GitHubPublicationAction, GitHubPublicationDetails } from "./chat-github-publication.tsx";
import { ChatPullRequestChecks } from "./chat-pull-request-checks.tsx";
import { chatPullRequestId } from "./chat-pull-requests.ts";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";

registerGitHubEnglish();

export type ChatPullRequestsProps = {
  pullRequests: ControlUiSessionPullRequest[];
  gateway?: ApplicationGateway;
  sessionKey?: string;
  sessionId?: string;
  presented?: PresentationValue;
  dismissed?: boolean;
  branch?: ControlUiSessionBranch;
  /** Hides the branch row and its idle publish offer; retained publication outcomes stay visible. */
  branchDismissed?: boolean;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  /** Compact row in the user-opened Details surface; actions keep their owners. */
  compact?: boolean;
};
const STATE_LABEL_KEYS = {
  merged: "chat.pullRequests.merged",
  draft: "chat.pullRequests.draft",
  closed: "chat.pullRequests.closed",
  open: "chat.pullRequests.open",
} as const;
const CHECK_LABEL_KEYS = {
  passing: "chat.pullRequests.checksPassing",
  failing: "chat.pullRequests.checksFailing",
  pending: "chat.pullRequests.checksPending",
} as const;

function retainedPublication(publication: GitHubPublicationView | undefined) {
  return (
    publication?.result ||
    publication?.locked ||
    (publication?.error && !publication.optionsUnavailable)
  );
}

function showWorkRow(props: ChatPullRequestsProps): boolean {
  return Boolean(
    (!props.branchDismissed && props.branch) ||
    (!props.pullRequests.length &&
      (retainedPublication(props.publication) ||
        (!props.branchDismissed &&
          props.publication?.canPublishShared &&
          !props.publication.canPublishPersonal &&
          props.publication.options?.shared))),
  );
}

export function hasChatPullRequests(props: ChatPullRequestsProps): boolean {
  return props.pullRequests.length > 0 || showWorkRow(props);
}

function ChecksRow(props: { label: string; count: number; modifier: string }) {
  return (
    <Show when={props.count !== 0}>
      <div class={["chat-pr__checks-row", `chat-pr__checks-row--${props.modifier}`]}>
        <span class="chat-pr__checks-row-dot" aria-hidden="true" />
        <span class="chat-pr__checks-row-label">{props.label}</span>
        <span class="chat-pr__checks-row-count">{props.count}</span>
      </div>
    </Show>
  );
}

function Checks(props: {
  pullRequest: ControlUiSessionPullRequest;
  compact?: boolean;
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
  return (
    <ChatPullRequestChecks
      label={label()}
      showLabel={props.compact}
      checksState={checks()?.state ?? "none"}
      presented={presented()}
      dismissed={props.dismissed}
    >
      <div
        class="chat-pr__checks-menu"
        role="group"
        aria-label={t("chat.pullRequests.ciMonitoring")}
      >
        <div class="chat-pr__checks-menu-header">
          <span>{t("chat.pullRequests.ciMonitoring")}</span>
          <a
            href={props.pullRequest.checksUrl ?? props.pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("chat.pullRequests.openChecks")}
          >
            <Icon name="externalLink" />
          </a>
        </div>
        <div class="chat-pr__checks-counts">
          <ChecksRow
            label={t("chat.pullRequests.checksFailed")}
            count={checks()?.failed ?? 0}
            modifier="failed"
          />
          <ChecksRow
            label={t("chat.pullRequests.checksPassed")}
            count={checks()?.passed ?? 0}
            modifier="passed"
          />
          <ChecksRow
            label={t("chat.pullRequests.checksRunning")}
            count={checks()?.running ?? 0}
            modifier="running"
          />
          <ChecksRow
            label={t("chat.pullRequests.checksSkipped")}
            count={checks()?.skipped ?? 0}
            modifier="skipped"
          />
          <Show when={!checks()}>{t("chat.pullRequests.automationNoChecks")}</Show>
        </div>
        <openclaw-chat-ci-automation
          prop:pullRequest={props.pullRequest}
          prop:gateway={props.gateway}
          prop:sessionKey={props.sessionKey ?? ""}
          prop:sessionId={props.sessionId ?? ""}
          prop:presented={presented()}
        />
        <Show when={checks()}>
          <openclaw-chat-ci-details
            prop:pullRequest={props.pullRequest}
            prop:gateway={props.gateway}
            prop:sessionKey={props.sessionKey ?? ""}
            prop:presented={presented()}
          />
        </Show>
      </div>
    </ChatPullRequestChecks>
  );
}

function StatusWarning(props: { status: ControlUiSessionPullRequestSnapshot["status"] }) {
  const message = () =>
    t(
      props.status === "rate-limited"
        ? "chat.pullRequests.rateLimited"
        : "chat.pullRequests.unavailable",
    );
  return (
    <Show when={props.status !== "ready"}>
      <openclaw-tooltip content={message()}>
        <span class="chat-pr__warning" role="img" aria-label={message()}>
          <Icon name="alertTriangle" />
        </span>
      </openclaw-tooltip>
    </Show>
  );
}

function WorkRow(props: {
  branch?: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  presented?: PresentationValue;
}) {
  const published = () =>
    !props.branch && props.publication?.result?.status === "published"
      ? props.publication.result
      : undefined;
  return (
    <article
      class="chat-pr"
      data-state={published() ? "published" : props.branch ? "branch" : "publication"}
    >
      <span class="chat-pr__link chat-pr__link--static">
        <span class="chat-pr__icon" aria-hidden="true">
          <Icon name={published() || !props.branch ? "gitPullRequest" : "gitBranch"} />
        </span>
        <span class="chat-pr__identity">
          <span class="chat-pr__repo">
            {published()?.repository ?? props.branch?.repo ?? t("chat.pullRequests.publishPr")}
          </span>
          <span class="chat-pr__branch">{published()?.branch ?? props.branch?.branch}</span>
        </span>
      </span>
      <span class="chat-pr__meta">
        <Show when={!published() ? props.branch : undefined}>
          {(branch) => (
            <SessionGitDiff
              classPrefix="chat-pr"
              item={branch()}
              onOpen={props.onOpenSessionDiff}
            />
          )}
        </Show>
        <StatusWarning status={props.status} />
        <Show
          when={props.publication}
          fallback={
            <Show when={props.branch?.createUrl}>
              {(url) => (
                <a
                  class="chat-pr__create"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("chat.pullRequests.createPrLabel", {
                    branch: props.branch?.branch ?? "",
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
        <Show when={props.branch && !published() && props.onDismissBranch}>
          <button
            class="chat-pr__dismiss"
            type="button"
            disabled={props.publication?.activity != null}
            aria-label={t("chat.pullRequests.dismissBranch", {
              branch: props.branch?.branch ?? "",
            })}
            onClick={() => {
              if (props.branch) {
                props.onDismissBranch?.(props.branch);
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

export function ChatPullRequests(props: ChatPullRequestsProps) {
  const published = () =>
    props.publication?.result?.status === "published" ? props.publication.result : undefined;
  const retained = () => retainedPublication(props.publication);
  const branch = () => (props.branchDismissed ? undefined : props.branch);
  const workRow = () => showWorkRow(props);
  const visible = createMemo(() => orderSessionPullRequests(props.pullRequests));
  const recovery = () =>
    retained() && (!published() || props.publication?.error) ? props.publication : undefined;
  return (
    <Show when={hasChatPullRequests(props)}>
      <div class="chat-prs" aria-live="polite">
        <Show
          when={workRow()}
          fallback={
            <>
              <For each={visible()} keyed={chatPullRequestId}>
                {(pullRequest) => (
                  <PullRequestRow
                    pullRequest={pullRequest()}
                    owner={props}
                    published={Boolean(published())}
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
          <WorkRow
            branch={branch()}
            status={props.status}
            onOpenSessionDiff={props.onOpenSessionDiff}
            publication={props.publication}
            onDismissBranch={props.onDismissBranch}
            presented={props.presented}
          />
        </Show>
      </div>
    </Show>
  );
}

function PullRequestActions(props: {
  label: string;
  dismissLabel: string;
  disabled: boolean;
  presented: PresentationValue;
  dismissed?: boolean;
  onDismiss: () => void;
}) {
  const id = createUniqueId();
  const parentPresented = useContext(ContentPresentation);
  const presentation = createMemo(() => projectPresentation(props.presented));
  const presented = () => parentPresented() && !props.dismissed && presentation().read();
  return (
    <Menu
      id={"chat-pr-actions-" + id}
      class="chat-pr__actions"
      label={props.label}
      triggerClass="chat-pr__actions-trigger"
      trigger={<Icon name="moreHorizontal" />}
      placement="bottom-end"
      disabled={props.disabled}
      items={[{ id: "dismiss", label: props.dismissLabel, disabled: props.disabled }]}
      open={presented() ? undefined : false}
      onBeforeShow={(event) => {
        if (!presented()) {
          event.preventDefault();
        }
      }}
      onSelect={() => props.onDismiss()}
    />
  );
}

function PullRequestRow(props: {
  pullRequest: ControlUiSessionPullRequest;
  owner: ChatPullRequestsProps;
  published: boolean;
}) {
  const compactDescription = () =>
    props.owner.compact
      ? [
          props.pullRequest.title,
          `${props.pullRequest.owner}/${props.pullRequest.repo}`,
          props.pullRequest.branch,
          t(STATE_LABEL_KEYS[props.pullRequest.state]),
          typeof props.pullRequest.additions === "number"
            ? `+${props.pullRequest.additions.toLocaleString()}`
            : null,
          typeof props.pullRequest.deletions === "number"
            ? `−${props.pullRequest.deletions.toLocaleString()}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;
  const dismissLabel = () =>
    t("chat.pullRequests.dismiss", { reference: formatGitHubItemReference(props.pullRequest) });
  const disabled = () => props.published && props.owner.publication?.activity !== null;
  const dismiss = () => {
    if (props.published) {
      props.owner.publication?.onNewAction?.();
    }
    props.owner.onDismiss(props.pullRequest);
  };
  return (
    <article
      class={["chat-pr", { "chat-pr--compact": props.owner.compact }]}
      data-state={props.pullRequest.state}
    >
      <Show when={props.owner.compact}>
        <div class="chat-pr__header">
          <span class="chat-pr__icon" aria-hidden="true">
            <Icon name={sessionPullRequestStateIcons[props.pullRequest.state]} />
          </span>
          <span
            class="chat-pr__repo"
            title={props.pullRequest.owner + "/" + props.pullRequest.repo}
          >
            {props.pullRequest.owner}/{props.pullRequest.repo}
          </span>
          <span class="chat-pr__number">#{props.pullRequest.number}</span>
          <PullRequestActions
            label={t("chat.pullRequests.actions", {
              reference: formatGitHubItemReference(props.pullRequest),
            })}
            dismissLabel={dismissLabel()}
            disabled={disabled()}
            presented={props.owner.presented ?? true}
            dismissed={props.owner.dismissed}
            onDismiss={dismiss}
          />
        </div>
      </Show>
      <a
        class="chat-pr__link"
        title={compactDescription()}
        aria-description={compactDescription()}
        href={props.pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("chat.pullRequests.linkLabel", {
          reference: formatGitHubItemReference(props.pullRequest),
          title: props.pullRequest.title,
        })}
      >
        <Show when={!props.owner.compact}>
          <span class="chat-pr__icon" aria-hidden="true">
            <Icon name={sessionPullRequestStateIcons[props.pullRequest.state]} />
          </span>
          <span class="chat-pr__number">{formatGitHubItemReference(props.pullRequest)}</span>
        </Show>
        <span class="chat-pr__identity" title={compactDescription()}>
          <Show
            when={props.owner.compact}
            fallback={<span class="chat-pr__branch">{props.pullRequest.branch}</span>}
          >
            <span class="chat-pr__title">{props.pullRequest.title}</span>
          </Show>
        </span>
      </a>
      <span class="chat-pr__meta">
        <SessionGitDiff classPrefix="chat-pr" item={props.pullRequest} />
        <Checks
          pullRequest={props.pullRequest}
          compact={props.owner.compact}
          gateway={props.owner.gateway}
          sessionKey={props.owner.sessionKey}
          sessionId={props.owner.sessionId}
          presented={props.owner.presented}
          dismissed={props.owner.dismissed}
        />
        <Show when={props.pullRequest.state !== "open"}>
          <span class="chat-pr__state">{t(STATE_LABEL_KEYS[props.pullRequest.state])}</span>
        </Show>
        <Show when={props.pullRequest.state !== "merged" || props.owner.status === "unavailable"}>
          <StatusWarning status={props.owner.status} />
        </Show>
        <Show when={!props.owner.compact}>
          <button
            class="chat-pr__dismiss"
            type="button"
            disabled={disabled()}
            aria-label={dismissLabel()}
            onClick={dismiss}
          >
            <Icon name="x" />
          </button>
        </Show>
      </span>
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
