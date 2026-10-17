import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  personalGitHubPublicationSelection,
  selectedGitHubPublisher,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-owner.ts";
import { GitHubPublicationMenu } from "./chat-github-publication-menu.tsx";

registerGitHubEnglish();

function sourceLabel(source: string): string {
  return t(
    source === "personal"
      ? "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : "githubPublication.system",
  );
}

function sharedUnavailableMessage(
  reason: NonNullable<GitHubPublicationView["options"]>["sharedUnavailableReason"],
): string {
  switch (reason) {
    case "unavailable":
      return t("githubPublication.sharedUnavailable.unavailable");
    case "changed":
      return t("githubPublication.sharedUnavailable.changed");
    case "rate_limited":
      return t("githubPublication.sharedUnavailable.rate_limited");
    case "unverified":
      return t("githubPublication.sharedUnavailable.unverified");
    case "unsupported_workspace":
      return t("githubPublication.sharedUnavailable.unsupported_workspace");
    default:
      return t("githubPublication.sharedUnavailable.unknown");
  }
}

function publicationButtonSelection(publication: GitHubPublicationView) {
  return (
    publication.selection ??
    (!publication.options?.shared ? personalGitHubPublicationSelection(publication.options) : null)
  );
}

export function GitHubPublicationAction(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
}) {
  const published = () => {
    const result = props.publication.result;
    return result?.status === "published" ? result : undefined;
  };
  const choices = createMemo(() => {
    const publication = props.publication;
    const personal = personalGitHubPublicationSelection(publication.options);
    const shared = publication.options?.shared;
    return publication.result || publication.locked || !publication.onSelect || !shared || !personal
      ? undefined
      : {
          accounts: [
            { source: "shared" as const, login: shared.login, label: sourceLabel(shared.source) },
            {
              source: "personal" as const,
              login: personal.account.login,
              label: sourceLabel("personal"),
            },
          ],
          duplicateLogin: shared.login === personal.account.login,
        };
  });
  return (
    <Show
      when={published()}
      fallback={
        <Show
          when={props.publication.optionsUnavailable}
          fallback={
            <>
              <PublicationButton publication={props.publication} />
              <Show when={choices()}>
                {(value) => (
                  <GitHubPublicationMenu
                    choices={value().accounts}
                    selected={props.publication.selection?.source}
                    duplicateLogin={value().duplicateLogin}
                    busy={props.publication.activity !== null}
                    presented={props.presented ?? true}
                    onSelect={(source) => props.publication.onSelect?.(source)}
                  />
                )}
              </Show>
            </>
          }
        >
          <PublicationRefresh
            publication={props.publication}
            tooltip={`${t("githubPublication.statusUnavailable")}: ${props.publication.error}`}
          />
        </Show>
      }
    >
      {(result) => (
        <>
          <a class="chat-pr__create" href={result().url} target="_blank" rel="noopener noreferrer">
            {t("chat.pullRequests.openPublishedPr")}
          </a>
          <Show when={props.publication.onNewAction}>
            <button
              class="chat-pr__dismiss"
              type="button"
              aria-label={t("common.dismiss")}
              disabled={props.publication.activity !== null}
              onClick={() => props.publication.onNewAction?.()}
            >
              <Icon name="x" />
            </button>
          </Show>
        </>
      )}
    </Show>
  );
}

function PublicationButton(props: { publication: GitHubPublicationView }) {
  const action = createMemo(() => {
    const publication = props.publication;
    const { result, activity } = publication;
    const selection = publicationButtonSelection(publication);
    const busy = activity !== null;
    const pendingLabel = t(activity === "read" ? "common.loading" : "chat.pullRequests.publishing");
    if (result?.status === "failed") {
      return {
        click: publication.onNewAction,
        label: t(
          publication.canPublishShared || publication.canPublishPersonal
            ? "githubPublication.newAction"
            : "common.dismiss",
        ),
        disabled: busy,
      };
    }
    if (result?.status === "needs_confirmation") {
      return {
        click: publication.onConfirm,
        label: t("githubPublication.confirm"),
        disabled: busy || !publication.personalReady,
      };
    }
    if (result?.status === "publishing" || result?.status === "requested") {
      return {
        click: publication.onRefresh,
        label: busy ? pendingLabel : t("githubPublication.check"),
        disabled: busy,
      };
    }
    return {
      click: publication.onPublish,
      disabled:
        busy || !selection || (selection.source === "personal" && !publication.personalReady),
      label: busy
        ? pendingLabel
        : publication.locked
          ? t("chat.pullRequests.retryPublication")
          : !publication.selection && selection?.source === "personal"
            ? t("githubPublication.publishAs", { account: selection.account.login })
            : t("chat.pullRequests.publishPr"),
    };
  });
  // Accepted shared requests retain their status button even without a replay callback.
  return (
    <Show
      when={
        action().click ||
        props.publication.result?.status === "publishing" ||
        props.publication.result?.status === "requested"
      }
    >
      <button
        class="chat-pr__create"
        type="button"
        disabled={action().disabled}
        onClick={() => action().click?.()}
      >
        {action().label}
      </button>
    </Show>
  );
}

function PublicationAccount(props: { publication: GitHubPublicationView }) {
  const publisher = () =>
    props.publication.result
      ? props.publication.result.publisher
      : selectedGitHubPublisher(props.publication.selection);
  return (
    <Show when={publisher()}>
      {(value) => (
        <span data-publication-account>
          {t("githubPublication.publishAs", { account: value().login })} ·{" "}
          {sourceLabel(value().source)}
        </span>
      )}
    </Show>
  );
}

function PublicationRefresh(props: { publication: GitHubPublicationView; tooltip?: string }) {
  return (
    <openclaw-tooltip content={props.tooltip ?? t("githubPublication.refresh")}>
      <button
        class="btn btn--ghost btn--icon chat-icon-btn chat-pr__publication-refresh"
        type="button"
        aria-label={t("githubPublication.refresh")}
        onClick={() => props.publication.onRefresh?.()}
      >
        <Icon name="refresh" />
      </button>
    </openclaw-tooltip>
  );
}

function PublicationEffect(props: {
  effect: NonNullable<GitHubPublicationView["result"]>["effect"];
}) {
  return (
    <Show when={props.effect}>
      {(effect) => (
        <span>
          {t(
            effect().status === "dispatched"
              ? "githubPublication.dispatched"
              : "githubPublication.observed",
            {
              kind: t(
                effect().kind === "push"
                  ? "githubPublication.effectPush"
                  : "githubPublication.effectPullRequest",
              ),
            },
          )}
          <Show when={effect().headCommit}>{(commit) => <code>{commit()}</code>}</Show>
          <Show when={effect().url}>
            {(url) => (
              <a href={url()} target="_blank" rel="noopener noreferrer">
                {t("githubPublication.effectLink")}
              </a>
            )}
          </Show>
        </span>
      )}
    </Show>
  );
}

// One short status line; server prose, account, and effects stay one click away.
function publicationHeadline(publication: GitHubPublicationView, busy: boolean) {
  const { result, error, locked } = publication;
  if (error) {
    return { text: t("githubPublication.statusUnavailable"), alert: true };
  }
  switch (result?.status) {
    case "failed":
      return { text: t("githubPublication.statusFailed"), alert: true };
    case "needs_confirmation":
      return { text: t("githubPublication.statusConfirm"), alert: false };
    case "publishing":
      return { text: t("githubPublication.statusPublishing"), alert: false };
    case "requested":
      return { text: t("githubPublication.statusRequested"), alert: false };
    default:
      if (!locked) {
        return null;
      }
      return busy
        ? { text: t("githubPublication.statusPublishing"), alert: false }
        : { text: t("githubPublication.statusUnknown"), alert: true };
  }
}

/** `inline` leaves disclosure ownership with the caller. */
export function GitHubPublicationDetails(props: {
  publication: GitHubPublicationView;
  inline?: boolean;
}) {
  const busy = () => props.publication.activity !== null;
  const personalUnavailable = () =>
    publicationButtonSelection(props.publication)?.source === "personal" &&
    !props.publication.personalReady;
  const noAccount = () => {
    const { options, result, locked } = props.publication;
    return Boolean(
      options &&
      !options.shared &&
      !personalGitHubPublicationSelection(options) &&
      !publicationButtonSelection(props.publication) &&
      !result &&
      !locked &&
      !busy() &&
      (props.publication.canPublishShared || props.publication.canPublishPersonal),
    );
  };
  const visible = () => {
    const { result, confirmation, error, locked, optionsUnavailable } = props.publication;
    return (
      !(result?.status === "published" && !error) &&
      !optionsUnavailable &&
      Boolean(result || confirmation || error || locked || personalUnavailable() || noAccount())
    );
  };
  const headline = () => publicationHeadline(props.publication, busy());
  const refresh = () =>
    !busy() &&
    (props.publication.error ||
      noAccount() ||
      props.publication.result?.status === "failed" ||
      (props.publication.result?.status === "needs_confirmation" && !props.publication.onConfirm));
  return (
    <Show when={visible()}>
      <div
        class="chat-pr__publication-outcome"
        data-state={props.publication.result?.status ?? "selection"}
      >
        <Show
          when={props.inline}
          fallback={
            <Show when={headline()}>
              {(value) => (
                <details class="chat-pr__publication-status">
                  <summary>
                    <span
                      class="chat-pr__publication-headline"
                      role={value().alert ? "alert" : "status"}
                    >
                      {value().text}
                    </span>
                    <span class="chat-pr__publication-chevron" aria-hidden="true">
                      <Icon name="chevronDown" />
                    </span>
                  </summary>
                  <PublicationMore publication={props.publication} busy={busy()} />
                </details>
              )}
            </Show>
          }
        >
          <PublicationMore publication={props.publication} busy={busy()} />
        </Show>
        <Show when={refresh()}>
          <PublicationRefresh publication={props.publication} />
        </Show>
        <Show when={noAccount()}>
          <span class="chat-pr__publication-note">
            {sharedUnavailableMessage(props.publication.options?.sharedUnavailableReason)}
            {props.publication.options?.personal === null
              ? t("githubPublication.unidentified")
              : null}
          </span>
        </Show>
        <Show when={props.publication.confirmation}>
          {(confirmation) => (
            <div class="chat-pr__publication-note">
              <div>
                {t("githubPublication.target", {
                  repository: confirmation().repository,
                  base: confirmation().baseBranch,
                })}
              </div>
              <div>
                {t("githubPublication.pushTarget", {
                  repository: confirmation().pushRepository,
                  branch: confirmation().branch,
                })}
              </div>
              <details>
                <summary>{t("githubPublication.snapshot")}</summary>
                <div>
                  {t("githubPublication.head")}: <code>{confirmation().sourceHeadCommit}</code>
                </div>
                <div>
                  {t("githubPublication.index")}: <code>{confirmation().sourceIndexTree}</code>
                </div>
                <div>
                  {t("githubPublication.workspace")}: <code>{confirmation().workspaceTree}</code>
                </div>
              </details>
            </div>
          )}
        </Show>
        <Show when={personalUnavailable()}>
          <span class="chat-pr__publication-note">{t("githubPublication.personalWorkspace")}</span>
        </Show>
      </div>
    </Show>
  );
}

function PublicationMore(props: { publication: GitHubPublicationView; busy: boolean }) {
  const message = () => {
    const result = props.publication.result;
    return result && result.status !== "published"
      ? result.status === "failed"
        ? result.nextAction
        : result.message
      : undefined;
  };
  return (
    <Show when={props.publication.result || props.publication.locked || props.publication.error}>
      <div class="chat-pr__publication-more">
        <PublicationAccount publication={props.publication} />
        <Show when={message()}>{(value) => <span>{value()}</span>}</Show>
        <Show when={props.publication.error}>{(error) => <span>{error()}</span>}</Show>
        <Show when={props.publication.locked && !props.publication.result && !props.busy}>
          <span>{t("githubPublication.unknown")}</span>
        </Show>
        <PublicationEffect effect={props.publication.result?.effect} />
      </div>
    </Show>
  );
}
