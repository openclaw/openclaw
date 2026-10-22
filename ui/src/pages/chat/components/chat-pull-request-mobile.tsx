import { Errored, For, latest, Show } from "solid-js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { GitDiffValues } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { sessionPullRequestStateIcons } from "../../../lib/session-pull-request-presentation.ts";
import { showToast } from "../../../lib/toast.ts";
import { createPullRequestCopy } from "./chat-pull-request-copy.ts";
import { ChecksRows } from "./chat-pull-request-shared.tsx";
import { chatPullRequestId } from "./chat-pull-requests.ts";
import "./chat-pull-request-presenters.css";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";

registerGitHubEnglish();

/** Recovery facts belong to the snapshot owner, including a successful empty result. */
export type ChatPullRequestMobileRecoveryProps = {
  status: ControlUiSessionPullRequestSnapshot["status"];
  hasSnapshot: boolean;
  lastUpdatedAt?: number;
  retrying: boolean;
  onRetry: () => void;
};

export function ChatPullRequestMobileRecovery(
  props: ChatPullRequestMobileRecoveryProps & {
    collection?: boolean;
  },
) {
  const failed = () => props.status !== "ready";
  return (
    <Show when={failed()}>
      <div
        class={[
          "chat-pr-mobile__recovery",
          { "chat-pr-mobile__recovery--empty": !props.hasSnapshot },
        ]}
        role="status"
      >
        <Show when={!props.hasSnapshot}>
          <Icon name="gitPullRequest" class="chat-pr-mobile__illustration" />
        </Show>
        <div class="chat-pr-mobile__recovery-copy">
          <strong>
            {t(
              props.hasSnapshot
                ? props.collection
                  ? "chat.pullRequests.couldNotUpdateMany"
                  : "chat.pullRequests.couldNotUpdate"
                : props.collection
                  ? "chat.pullRequests.couldNotLoadMany"
                  : "chat.pullRequests.couldNotLoad",
            )}
          </strong>
          <Show when={props.hasSnapshot} fallback={<p>{t("chat.pullRequests.tryAgain")}</p>}>
            <Show when={props.lastUpdatedAt !== undefined}>
              <p>
                {t("chat.pullRequests.lastUpdated", {
                  time: new Date(props.lastUpdatedAt!).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}
              </p>
            </Show>
          </Show>
        </div>
        <button
          type="button"
          class="btn primary chat-pr-mobile__retry"
          disabled={props.retrying}
          onClick={() => props.onRetry()}
        >
          <Show when={props.retrying}>
            <span class="btn__spinner" aria-hidden="true" />
          </Show>
          {t("chat.pullRequests.retry")}
        </button>
      </div>
    </Show>
  );
}

export type ChatPullRequestMobileRowProps = {
  pullRequest: ControlUiSessionPullRequest;
  onOpen: (pullRequest: ControlUiSessionPullRequest) => void;
};

/** A whole-row destination. The host retains origin/Back and chooses the root subset. */
export function ChatPullRequestMobileRow(props: ChatPullRequestMobileRowProps) {
  return (
    <button
      type="button"
      class="chat-pr-mobile__row"
      data-state={props.pullRequest.state}
      onClick={() => props.onOpen(props.pullRequest)}
    >
      <Icon
        name={sessionPullRequestStateIcons[props.pullRequest.state]}
        class="chat-pr-mobile__state-icon"
      />
      <span class="chat-pr-mobile__row-copy">
        <span class="chat-pr-mobile__row-title">{props.pullRequest.title}</span>
        <span class="chat-pr-mobile__row-meta">
          <span>{props.pullRequest.repo}</span>
          <span aria-hidden="true"> · </span>
          <span>#{props.pullRequest.number}</span>
          <Show
            when={
              props.pullRequest.additions !== undefined || props.pullRequest.deletions !== undefined
            }
          >
            <span aria-hidden="true"> · </span>
            <GitDiffValues item={props.pullRequest} classPrefix="chat-pr" locale="en-US" spaced />
          </Show>
        </span>
      </span>
      <Icon name="chevronRight" class="chat-pr-mobile__chevron" />
    </button>
  );
}

export type ChatPullRequestMobileCollectionProps = ChatPullRequestMobileRecoveryProps & {
  /** Already ordered by the existing owner; this presenter never sorts or truncates. */
  pullRequests: readonly ControlUiSessionPullRequest[];
  onOpen: (pullRequest: ControlUiSessionPullRequest) => void;
};

export function ChatPullRequestMobileCollection(props: ChatPullRequestMobileCollectionProps) {
  return (
    <div class="chat-pr-mobile">
      <ChatPullRequestMobileRecovery {...props} collection />
      <Show when={props.hasSnapshot}>
        <Show
          when={props.pullRequests.length}
          fallback={<p class="chat-pr-mobile__empty">{t("chat.pullRequests.empty")}</p>}
        >
          <div class="chat-pr-mobile__group">
            <For each={props.pullRequests} keyed={chatPullRequestId}>
              {(pullRequest) => (
                <ChatPullRequestMobileRow pullRequest={pullRequest()} onOpen={props.onOpen} />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

export type ChatPullRequestMobileDetailProps = ChatPullRequestMobileRecoveryProps & {
  pullRequest?: ControlUiSessionPullRequest;
  dismissDisabled?: boolean;
  onOpenChecks?: () => void;
  onOpenMonitoring?: () => void;
  /** The host decides the destination after the native session dismissal succeeds. */
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
};

/** Body only: actual title, Back, scroll fades and presentation are owned by the mobile host. */
export function ChatPullRequestMobileDetail(props: ChatPullRequestMobileDetailProps) {
  const clipboard = createPullRequestCopy({
    url: () => props.pullRequest?.url,
    presented: () => props.hasSnapshot,
    onCopied: () => showToast({ message: t("chat.pullRequests.linkCopied") }),
  });
  return (
    <div class="chat-pr-mobile">
      <ChatPullRequestMobileRecovery {...props} />
      <Show when={props.hasSnapshot ? props.pullRequest : undefined}>
        {(pullRequest) => (
          <>
            <section class="chat-pr-mobile__metadata" aria-label={t("chat.pullRequests.details")}>
              <div class="chat-pr-mobile__identity">
                <span>
                  {pullRequest().owner}/{pullRequest().repo}{" "}
                  <span class="chat-pr-mobile__number">#{pullRequest().number}</span>
                </span>
                <span class="chat-pr-mobile__state" data-state={pullRequest().state}>
                  <Icon name={sessionPullRequestStateIcons[pullRequest().state]} />
                  {t(`chat.pullRequests.${pullRequest().state}`)}
                </span>
              </div>
              <div class="chat-pr-mobile__group chat-pr-mobile__branch-group">
                <div class="chat-pr-mobile__branch">
                  <Icon name="gitBranch" />
                  <span>{pullRequest().branch}</span>
                </div>
                <Show
                  when={
                    pullRequest().additions !== undefined ||
                    pullRequest().deletions !== undefined ||
                    pullRequest().changedFiles !== undefined
                  }
                >
                  <div class="chat-pr-mobile__diff">
                    <Show when={pullRequest().changedFiles !== undefined}>
                      <span>
                        {t("chat.pullRequests.changedFiles", {
                          count: String(pullRequest().changedFiles),
                        })}
                      </span>
                    </Show>
                    <GitDiffValues item={pullRequest()} classPrefix="chat-pr" locale="en-US" />
                  </div>
                </Show>
              </div>
              <Show when={pullRequest().author}>
                {(author) => (
                  <div class="chat-pr-mobile__author">
                    <span class="chat-pr-mobile__avatar" aria-hidden="true">
                      {author().login.slice(0, 2).toUpperCase()}
                    </span>
                    <span>@{author().login}</span>
                  </div>
                )}
              </Show>
            </section>
            <Show
              when={
                pullRequest().checksUrl ||
                (pullRequest().checks &&
                  Object.values(pullRequest().checks!).some(
                    (value) => typeof value === "number" && value > 0,
                  ))
              }
            >
              <section
                class="chat-pr-mobile__checks"
                aria-label={t("chat.pullRequests.checksTitle")}
              >
                <h3>{t("chat.pullRequests.checksTitle")}</h3>
                <div class="chat-pr-mobile__group chat-pr-mobile__check-rows">
                  <ChecksRows checks={pullRequest().checks} />
                  <Show when={pullRequest().checksUrl}>
                    {(url) => (
                      <a
                        class="chat-pr-mobile__checks-link"
                        href={url()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Icon name="listChecks" />
                        <span>{t("chat.pullRequests.viewChecks")}</span>
                        <Icon name="externalLink" />
                      </a>
                    )}
                  </Show>
                </div>
              </section>
            </Show>
            <div class="chat-pr-mobile__group chat-pr-mobile__actions">
              <Show when={props.onOpenChecks}>
                <button type="button" onClick={() => props.onOpenChecks?.()}>
                  <Icon name="listChecks" />
                  <span>{t("chat.pullRequests.checksTitle")}</span>
                  <Icon name="chevronRight" />
                </button>
              </Show>
              <Show when={props.onOpenMonitoring}>
                <button type="button" onClick={() => props.onOpenMonitoring?.()}>
                  <Icon name="listChecks" />
                  <span>{t("chat.pullRequests.ciMonitoring")}</span>
                  <Icon name="chevronRight" />
                </button>
              </Show>
              <a href={pullRequest().url} target="_blank" rel="noopener noreferrer">
                <Icon name="github" />
                <span>{t("chat.pullRequests.openGitHub")}</span>
                <Icon name="externalLink" />
              </a>
              <button
                type="button"
                disabled={clipboard.copying()}
                onClick={() => void clipboard.copy()}
              >
                <Icon name="link" />
                <span>{t("chat.pullRequests.copyLink")}</span>
              </button>
              <Show when={!clipboard.copying()}>
                <Errored
                  fallback={
                    <p class="chat-pr-menu__error" role="alert">
                      {t("chat.pullRequests.copyFailed")}
                    </p>
                  }
                >
                  {latest(clipboard.outcome)}
                </Errored>
              </Show>
              <button
                type="button"
                class="chat-pr-mobile__hide"
                disabled={props.dismissDisabled}
                onClick={() => props.onDismiss(pullRequest())}
              >
                <Icon name="eyeOff" />
                <span>{t("chat.pullRequests.hide")}</span>
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

export type ChatPullRequestMobileCiProps = ChatPullRequestMobileRecoveryProps & {
  pullRequest?: ControlUiSessionPullRequest;
  gateway?: ApplicationGateway;
  sessionKey: string;
  sessionId?: string;
  presented: boolean;
};

/** Native CI owners retain requests and mutations across the host's nested pages. */
export function ChatPullRequestMobileChecks(props: ChatPullRequestMobileCiProps) {
  return (
    <div class="chat-pr-mobile">
      <ChatPullRequestMobileRecovery {...props} />
      <Show when={props.pullRequest}>
        {(pullRequest) => (
          <>
            <openclaw-chat-ci-details
              prop:pullRequest={pullRequest()}
              prop:gateway={props.gateway}
              prop:sessionKey={props.sessionKey}
              prop:presented={props.presented}
              prop:inline={true}
            />
            <Show when={pullRequest().checksUrl}>
              {(url) => (
                <a
                  class="chat-pr-mobile__checks-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="externalLink" />
                  <span>{t("chat.pullRequests.openChecks")}</span>
                </a>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

export function ChatPullRequestMobileMonitoring(props: ChatPullRequestMobileCiProps) {
  return (
    <div class="chat-pr-mobile">
      <ChatPullRequestMobileRecovery {...props} />
      <Show when={props.pullRequest}>
        {(pullRequest) => (
          <openclaw-chat-ci-automation
            prop:pullRequest={pullRequest()}
            prop:gateway={props.gateway}
            prop:sessionKey={props.sessionKey}
            prop:sessionId={props.sessionId ?? ""}
            prop:presented={props.presented}
            prop:inline={true}
            prop:menuPresentation={true}
          />
        )}
      </Show>
    </div>
  );
}
