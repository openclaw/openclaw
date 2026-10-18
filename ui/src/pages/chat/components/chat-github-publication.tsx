import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import "../../../components/tooltip.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  personalGitHubPublicationSelection,
  selectedGitHubPublisher,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-owner.ts";
import { GitHubPublicationAvatar, GitHubPublicationMenu } from "./chat-github-publication-menu.tsx";

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

function publicationButtonSelection(publication: GitHubPublicationView) {
  return (
    publication.selection ??
    (!publication.options?.shared ? personalGitHubPublicationSelection(publication.options) : null)
  );
}

/** The same eligible choices serve the inline menu and the mobile account row. */
export function GitHubPublicationAccountSelector(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
  mobile?: boolean;
  /** Opt embedded controls into the containing Menu’s traversal. */
  menuControls?: boolean;
}) {
  const choices = createMemo(() => {
    const publication = props.publication;
    const personal = personalGitHubPublicationSelection(publication.options);
    const shared = publication.options?.shared;
    return publication.result ||
      publication.locked ||
      publication.optionsUnavailable ||
      !publication.onSelect ||
      !shared ||
      !personal
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
  const publisher = () =>
    props.publication.result
      ? props.publication.result.publisher
      : selectedGitHubPublisher(publicationButtonSelection(props.publication));
  const accountRow = () => (
    <span class="github-publication-mobile__account-row">
      <span>{t("githubPublication.publishAsLabel")}</span>
      <Show when={publisher()}>
        {(value) => (
          <span class="github-publication-mobile__account-identity">
            <GitHubPublicationAvatar login={value().login} />
            <span class="github-publication-mobile__login" aria-label={`@${value().login}`}>
              @{value().login}
            </span>
          </span>
        )}
      </Show>
      <Show when={choices()}>
        <Icon name="chevronsUpDown" />
      </Show>
    </span>
  );
  return (
    <Show when={choices()} fallback={props.mobile && publisher() ? accountRow() : undefined}>
      {(value) => (
        <GitHubPublicationMenu
          choices={value().accounts}
          selected={props.publication.selection?.source}
          duplicateLogin={value().duplicateLogin}
          busy={props.publication.activity !== null}
          presented={props.presented ?? true}
          mobile={props.mobile}
          menuControls={props.menuControls}
          trigger={props.mobile ? accountRow() : undefined}
          onSelect={(source) => props.publication.onSelect?.(source)}
        />
      )}
    </Show>
  );
}

export function GitHubPublicationAction(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
  /** Mobile places the account selector above the outcome and the primary action. */
  mobile?: boolean;
  /** Opt embedded controls into the containing Menu’s traversal. */
  menuControls?: boolean;
  onOpenPublished?: (
    result: Extract<NonNullable<GitHubPublicationView["result"]>, { status: "published" }>,
  ) => void;
}) {
  const published = () => {
    const result = props.publication.result;
    return result?.status === "published" ? result : undefined;
  };
  return (
    <Show
      when={published()}
      fallback={
        <Show
          when={props.publication.optionsUnavailable}
          fallback={
            <>
              <PublicationButton publication={props.publication} />
              <Show when={!props.mobile}>
                <GitHubPublicationAccountSelector
                  publication={props.publication}
                  presented={props.presented}
                  menuControls={props.menuControls}
                />
              </Show>
            </>
          }
        >
          <PublicationRefresh
            publication={props.publication}
            tooltip={`${t("githubPublication.statusUnavailable")}: ${props.publication.error}`}
            labelled={props.mobile}
            hideTooltip={props.mobile}
          />
        </Show>
      }
    >
      {(result) => (
        <>
          <a
            class="chat-pr__create"
            href={result().url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              if (props.onOpenPublished && shouldHandleNavigationClick(event)) {
                event.preventDefault();
                props.onOpenPublished(result());
              }
            }}
          >
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

function PublicationRefresh(props: {
  publication: GitHubPublicationView;
  tooltip?: string;
  labelled?: boolean;
  hideTooltip?: boolean;
}) {
  return (
    <openclaw-tooltip
      content={props.tooltip ?? t("githubPublication.refresh")}
      prop:disabled={props.hideTooltip}
    >
      <button
        class={
          props.labelled
            ? "chat-pr__create"
            : "btn btn--ghost btn--icon chat-icon-btn chat-pr__publication-refresh"
        }
        type="button"
        aria-label={t("githubPublication.refresh")}
        onClick={() => props.publication.onRefresh?.()}
      >
        <Icon name="refresh" />
        <Show when={props.labelled}>{t("githubPublication.refresh")}</Show>
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

function publicationHasNoAccount(publication: GitHubPublicationView) {
  const { options, result, locked } = publication;
  return Boolean(
    options &&
    !options.shared &&
    !personalGitHubPublicationSelection(options) &&
    !publicationButtonSelection(publication) &&
    !result &&
    !locked &&
    publication.activity === null &&
    (publication.canPublishShared || publication.canPublishPersonal),
  );
}

export function GitHubPublicationMobileRefresh(props: { publication: GitHubPublicationView }) {
  const visible = () =>
    props.publication.activity === null &&
    (props.publication.optionsUnavailable ||
      props.publication.error ||
      publicationHasNoAccount(props.publication) ||
      props.publication.result?.status === "failed" ||
      (props.publication.result?.status === "needs_confirmation" && !props.publication.onConfirm));
  return (
    <Show when={visible()}>
      <PublicationRefresh publication={props.publication} hideTooltip />
    </Show>
  );
}

/** `inline` leaves disclosure ownership with the caller. */
export function GitHubPublicationDetails(props: {
  publication: GitHubPublicationView;
  inline?: boolean;
  mobile?: boolean;
  menuControls?: boolean;
}) {
  const busy = () => props.publication.activity !== null;
  const personalUnavailable = () =>
    publicationButtonSelection(props.publication)?.source === "personal" &&
    !props.publication.personalReady;
  const noAccount = () => publicationHasNoAccount(props.publication);
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
                  <summary data-form-control={props.menuControls ? "" : undefined}>
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
        <Show when={!props.mobile && refresh()}>
          <PublicationRefresh publication={props.publication} hideTooltip={props.mobile} />
        </Show>
        <Show when={noAccount()}>
          <span class="chat-pr__publication-note">
            {t(
              `githubPublication.sharedUnavailable.${props.publication.options?.sharedUnavailableReason ?? "unknown"}`,
            )}
            {props.publication.options?.personal === null
              ? `${props.mobile ? " " : ""}${t("githubPublication.unidentified")}`
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
                <summary data-form-control={props.menuControls ? "" : undefined}>
                  {t("githubPublication.snapshot")}
                </summary>
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
