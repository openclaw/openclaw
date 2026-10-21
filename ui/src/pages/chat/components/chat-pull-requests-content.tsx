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
import { createMenuControls, Menu, type MenuHandle } from "../../../components/solid/menu.tsx";
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
import { HoverMarquee } from "../../../lib/solid/hover-marquee.tsx";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { GitHubPublicationAction, GitHubPublicationDetails } from "./chat-github-publication.tsx";
import { PullRequestActions } from "./chat-pull-request-actions.tsx";
import { ChatPullRequestChecks } from "./chat-pull-request-checks.tsx";
import {
  ChecksRows,
  StatusWarning,
  STATE_LABEL_KEYS,
  type ChatPullRequestsProps,
} from "./chat-pull-request-shared.tsx";
import {
  chatPullRequestId,
  hasChatPullRequests,
  retainedPublication,
  showWorkRow,
} from "./chat-pull-requests.ts";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";
import "./chat-pull-request-presenters.css";

registerGitHubEnglish();

const CHECK_LABEL_KEYS = {
  passing: "chat.pullRequests.checksPassing",
  failing: "chat.pullRequests.checksFailing",
  pending: "chat.pullRequests.checksPending",
} as const;

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
  const content = () => (
    <div class="chat-pr__checks-menu" role="group" aria-label={t("chat.pullRequests.ciMonitoring")}>
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
  );
  return (
    <ChatPullRequestChecks
      label={label()}
      showLabel={props.compact}
      checksState={checks()?.state ?? "none"}
      presented={presented()}
      dismissed={props.dismissed}
    >
      {content()}
    </ChatPullRequestChecks>
  );
}

function WorkRow(props: {
  branch?: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  presented?: PresentationValue;
  compact?: boolean;
}) {
  const published = () =>
    !props.branch && props.publication?.result?.status === "published"
      ? props.publication.result
      : undefined;
  return (
    <Show
      when={props.compact ? props.branch : undefined}
      fallback={
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
      }
    >
      {(branch) => (
        <article class="chat-pr chat-pr--summary chat-pr--unpublished" data-state="branch">
          <span class="chat-pr__link chat-pr__link--static">
            <span class="chat-pr__icon" aria-hidden="true">
              <Icon name="gitBranch" />
            </span>
            <span class="chat-pr__branch">{branch().branch}</span>
          </span>
          <SessionGitDiff classPrefix="chat-pr" item={branch()} onOpen={props.onOpenSessionDiff} />
          <BranchActions
            branch={branch()}
            status={props.status}
            publication={props.publication}
            presented={props.presented}
            onDismiss={props.onDismissBranch}
          />
        </article>
      )}
    </Show>
  );
}

function BranchActions(props: {
  branch: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  publication?: GitHubPublicationView;
  presented?: PresentationValue;
  onDismiss?: (branch: ControlUiSessionBranch) => void;
}) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const createLinkRef = controls.ref();
  const dismissRef = controls.ref();
  let menu: MenuHandle | undefined;
  const parentPresented = useContext(ContentPresentation);
  const presentation = createMemo(() => projectPresentation(props.presented ?? true));
  const presented = () => parentPresented() && presentation().read();

  return (
    <Menu
      controls={controls}
      id={"chat-pr-branch-actions-" + id}
      class="chat-pr__actions"
      label={t("chat.pullRequests.actions", { reference: props.branch.branch })}
      triggerClass="chat-pr__actions-trigger"
      trigger={<Icon name="moreHorizontal" />}
      placement="bottom-end"
      panelClass="chat-pr-menu chat-pr-branch-menu"
      open={presented() ? undefined : false}
      items={[]}
      onBeforeShow={(event) => {
        if (!presented()) {
          event.preventDefault();
        }
      }}
      ref={(handle) => {
        menu = handle;
      }}
    >
      <>
        <Show
          when={props.publication}
          fallback={
            <Show when={props.branch.createUrl}>
              {(url) => (
                <a
                  ref={createLinkRef}
                  class="oc-menu-item"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("chat.pullRequests.createPrLabel", { branch: props.branch.branch })}
                >
                  <span class="oc-menu-item__icon">
                    <Icon name="externalLink" />
                  </span>
                  {t("chat.pullRequests.createPr")}
                </a>
              )}
            </Show>
          }
        >
          {(publication) => (
            <div class="chat-pr-branch-menu__publication">
              <GitHubPublicationAction
                publication={publication()}
                presented={presented()}
                menuControls
                controls={controls}
              />
              <GitHubPublicationDetails
                publication={publication()}
                menuControls
                controls={controls}
              />
            </div>
          )}
        </Show>
        <StatusWarning status={props.status} />
        <Show when={props.onDismiss}>
          <div class="chat-pr-menu__group">
            <button
              ref={dismissRef}
              class="oc-menu-item"
              data-variant="danger"
              type="button"
              disabled={props.publication?.activity != null}
              aria-label={t("chat.pullRequests.dismissBranch", { branch: props.branch.branch })}
              onClick={() => {
                menu?.close();
                props.onDismiss?.(props.branch);
              }}
            >
              <span class="oc-menu-item__icon">
                <Icon name="eyeOff" />
              </span>
              {t("chat.pullRequests.hide")}
            </button>
          </div>
        </Show>
      </>
    </Menu>
  );
}

export function ChatPullRequestsContent(props: ChatPullRequestsProps) {
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
            compact={props.compact}
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

function PullRequestRow(props: {
  pullRequest: ControlUiSessionPullRequest;
  owner: ChatPullRequestsProps;
  published: boolean;
}) {
  let row: HTMLElement | undefined;
  const dismissLabel = () =>
    t("chat.pullRequests.dismiss", { reference: formatGitHubItemReference(props.pullRequest) });
  const disabled = () => props.published && props.owner.publication?.activity !== null;
  const dismiss = () => {
    if (props.published) {
      props.owner.publication?.onNewAction?.();
    }
    props.owner.onDismiss(props.pullRequest);
  };
  const badge = () => {
    const checks = props.pullRequest.checks;
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
      data-state={props.pullRequest.state}
    >
      <a
        class="chat-pr__link"
        data-link-reader-preview={props.owner.compact ? "off" : undefined}
        href={props.pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("chat.pullRequests.linkLabel", {
          reference: formatGitHubItemReference(props.pullRequest),
          title: props.pullRequest.title,
        })}
      >
        <span class="chat-pr__icon" aria-hidden="true">
          <Icon name={sessionPullRequestStateIcons[props.pullRequest.state]} />
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
          <span class="chat-pr__number">{formatGitHubItemReference(props.pullRequest)}</span>
        </Show>
        <span class="chat-pr__identity">
          <Show
            when={props.owner.compact}
            fallback={<span class="chat-pr__branch">{props.pullRequest.branch}</span>}
          >
            <HoverMarquee
              class="chat-pr__title"
              content={props.pullRequest.title}
              options={{
                host: () => (row?.closest(".chat-details[data-desktop]") ? row : undefined),
              }}
            />
          </Show>
        </span>
      </a>
      <Show
        when={props.owner.compact}
        fallback={
          <span class="chat-pr__meta">
            <SessionGitDiff classPrefix="chat-pr" item={props.pullRequest} />
            <Checks
              pullRequest={props.pullRequest}
              gateway={props.owner.gateway}
              sessionKey={props.owner.sessionKey}
              sessionId={props.owner.sessionId}
              presented={props.owner.presented}
              dismissed={props.owner.dismissed}
            />
            <Show when={props.pullRequest.state !== "open"}>
              <span class="chat-pr__state">{t(STATE_LABEL_KEYS[props.pullRequest.state])}</span>
            </Show>
            <Show
              when={props.pullRequest.state !== "merged" || props.owner.status === "unavailable"}
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
        }
      >
        <PullRequestActions
          label={t("chat.pullRequests.actions", {
            reference: formatGitHubItemReference(props.pullRequest),
          })}
          disabled={disabled()}
          presented={props.owner.presented ?? true}
          dismissed={props.owner.dismissed}
          onDismiss={dismiss}
          pullRequest={props.pullRequest}
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
