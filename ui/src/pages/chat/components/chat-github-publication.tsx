import {
  action as nativeAction,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  Loading,
  onSettled,
  refresh as refreshRead,
  Show,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import type { MenuControls } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import "../../../components/tooltip.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  personalGitHubPublicationSelection,
  selectedGitHubPublisher,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-owner.ts";
import { GitHubPublicationAvatar, GitHubPublicationMenu } from "./chat-github-publication-menu.tsx";

registerGitHubEnglish();

/** The owner admits and records work; Solid consumes only completion and presentation. */
function createPublicationAction(publication: () => GitHubPublicationView) {
  const retirement = createMemo(() => ({ retired: publication().readiness.retired }), {
    equals: (previous, next) => previous.retired === next.retired,
  });
  const presentation = createMemo(() => {
    const { retired } = retirement();
    const [busy, setBusy] = createOptimistic(false);
    return { retired, busy, setBusy };
  });
  const [receipt, setReceipt] = createSignal<{
    retired: Promise<void>;
    completion: Promise<void>;
  } | null>(null);
  const read = createMemo(() => {
    const { read: completion, retired } = publication().readiness;
    return completion ? Promise.race([completion, retired]) : null;
  });
  const outcome = createMemo(() => {
    const action = receipt();
    return action?.retired === retirement().retired ? action.completion : null;
  });
  const present = nativeAction(function* (
    view: ReturnType<typeof presentation>,
    completion: Promise<void>,
  ) {
    if (view === presentation()) {
      view.setBusy(true);
      affects(read);
    }
    const settled: boolean = yield Promise.race([
      completion.then(() => true),
      view.retired.then(() => false),
    ]);
    if (settled && view === presentation()) {
      // Reconcile the owner's accepted receipt; refreshing never admits another RPC.
      yield refreshRead(read);
    }
  });
  return {
    scope: retirement,
    read,
    outcome,
    error: (error: () => unknown, reset: () => void) => (
      <LazyViewError
        error={error()}
        onRetry={() => {
          setReceipt(null);
          reset();
        }}
        inline
      />
    ),
    busy: () => presentation().busy() || publication().activity !== null,
    run(callback: (() => void | Promise<void>) | undefined) {
      const view = presentation();
      const completion = callback?.();
      if (completion) {
        // Acknowledgement can retire its binding; commit that owner change first.
        onSettled(() => {
          const pending = present(view, completion);
          // An owner update can remove these controls before the outcome is observed.
          void pending.catch(() => {});
          setReceipt({ retired: view.retired, completion: pending });
        });
      }
    },
  };
}

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

/** One eligible-choice projection serves every publication presentation. */
export function githubPublicationAccountChoices(publication: GitHubPublicationView) {
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
}

export function GitHubPublicationAccountSelector(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
  mobile?: boolean;
  /** Opt embedded controls into the containing Menu’s traversal. */
  menuControls?: boolean;
  controls?: MenuControls;
}) {
  const choices = createMemo(() => githubPublicationAccountChoices(props.publication));
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
            <span
              ref={createTextOverflow(() => value().login)}
              class="github-publication-mobile__login"
              aria-label={`@${value().login}`}
              title={`@${value().login}`}
            >
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
          controls={props.controls}
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
  /** A containing menu can present the same eligible account choices. */
  accountSelector?: boolean;
  publishLabel?: string;
  pendingLabel?: string;
  /** Opt embedded controls into the containing Menu’s traversal. */
  menuControls?: boolean;
  controls?: MenuControls;
}) {
  const operation = createPublicationAction(() => props.publication);
  const publishedLinkRef = props.controls?.ref();
  const dismissRef = props.controls?.ref();
  const published = () => {
    const result = props.publication.result;
    return result?.status === "published" ? result : undefined;
  };
  return (
    <Errored fallback={operation.error}>
      <Show
        when={published()}
        fallback={
          <Show
            when={props.publication.optionsUnavailable}
            fallback={
              <>
                <PublicationButton
                  publication={props.publication}
                  controls={props.controls}
                  publishLabel={props.publishLabel}
                  pendingLabel={props.pendingLabel}
                />
                <Show when={!props.mobile && props.accountSelector !== false}>
                  <GitHubPublicationAccountSelector
                    publication={props.publication}
                    presented={props.presented}
                    menuControls={props.menuControls}
                    controls={props.controls}
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
              controls={props.controls}
            />
          </Show>
        }
      >
        {(result) => (
          <>
            <a
              ref={(element) => publishedLinkRef?.(element)}
              class="chat-pr__create"
              href={result().url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("chat.pullRequests.openPublishedPr")}
            </a>
            <Show when={props.publication.onNewAction}>
              <button
                ref={(element) => dismissRef?.(element)}
                class="chat-pr__dismiss"
                type="button"
                aria-label={t("common.dismiss")}
                disabled={operation.busy()}
                onClick={() => operation.run(props.publication.onNewAction)}
              >
                <Loading on={operation.scope()} fallback={<Icon name="x" />}>
                  {(() => {
                    operation.read();
                    operation.outcome();
                    return <Icon name="x" />;
                  })()}
                </Loading>
              </button>
            </Show>
          </>
        )}
      </Show>
    </Errored>
  );
}

function PublicationButton(props: {
  publication: GitHubPublicationView;
  controls?: MenuControls;
  publishLabel?: string;
  pendingLabel?: string;
}) {
  const controlRef = props.controls?.ref();
  const operation = createPublicationAction(() => props.publication);
  const action = createMemo(() => {
    const publication = props.publication;
    const result = publication.result;
    const selection = publicationButtonSelection(publication);
    const busy = operation.busy();
    const pendingLabel =
      publication.activity === "read"
        ? t("common.loading")
        : (props.pendingLabel ?? t("chat.pullRequests.publishing"));
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
            : (props.publishLabel ?? t("chat.pullRequests.publishPr")),
    };
  });
  // Accepted shared requests retain their status button even without a replay callback.
  return (
    <Errored fallback={operation.error}>
      <Show
        when={
          action().click ||
          props.publication.result?.status === "publishing" ||
          props.publication.result?.status === "requested"
        }
      >
        <button
          ref={(element) => controlRef?.(element)}
          class="chat-pr__create"
          type="button"
          disabled={action().disabled}
          onClick={() => operation.run(action().click)}
        >
          <Show when={operation.busy()}>
            <span class="btn__spinner" aria-hidden="true" />
          </Show>
          {action().label}
          <Loading on={operation.scope()} fallback={null}>
            {(() => {
              operation.read();
              operation.outcome();
              return null;
            })()}
          </Loading>
        </button>
      </Show>
    </Errored>
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
  controls?: MenuControls;
}) {
  const controlRef = props.controls?.ref();
  const operation = createPublicationAction(() => props.publication);
  return (
    <Errored fallback={operation.error}>
      <openclaw-tooltip
        content={props.tooltip ?? t("githubPublication.refresh")}
        prop:disabled={props.hideTooltip}
      >
        <button
          ref={(element) => controlRef?.(element)}
          class={
            props.labelled
              ? "chat-pr__create"
              : "btn btn--ghost btn--icon chat-icon-btn chat-pr__publication-refresh"
          }
          type="button"
          aria-label={t("githubPublication.refresh")}
          disabled={operation.busy()}
          onClick={() => operation.run(props.publication.onRefresh)}
        >
          <Loading on={operation.scope()} fallback={<Icon name="refresh" />}>
            {(() => {
              operation.read();
              operation.outcome();
              return <Icon name="refresh" />;
            })()}
          </Loading>
          <Show when={props.labelled}>{t("githubPublication.refresh")}</Show>
        </button>
      </openclaw-tooltip>
    </Errored>
  );
}

function PublicationEffect(props: {
  effect: NonNullable<GitHubPublicationView["result"]>["effect"];
  controls?: MenuControls;
}) {
  const linkRef = props.controls?.ref();
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
              <a
                ref={(element) => linkRef?.(element)}
                href={url()}
                target="_blank"
                rel="noopener noreferrer"
              >
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
  controls?: MenuControls;
}) {
  const statusRef = props.controls?.ref();
  const snapshotRef = props.controls?.ref();
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
                  <summary
                    ref={(element) => statusRef?.(element)}
                    data-form-control={props.menuControls ? "" : undefined}
                  >
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
                  <PublicationMore
                    publication={props.publication}
                    busy={busy()}
                    controls={props.controls}
                  />
                </details>
              )}
            </Show>
          }
        >
          <PublicationMore
            publication={props.publication}
            busy={busy()}
            controls={props.controls}
          />
        </Show>
        <Show when={!props.mobile && refresh()}>
          <PublicationRefresh
            publication={props.publication}
            hideTooltip={props.mobile}
            controls={props.controls}
          />
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
                <summary
                  ref={(element) => snapshotRef?.(element)}
                  data-form-control={props.menuControls ? "" : undefined}
                >
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

function PublicationMore(props: {
  publication: GitHubPublicationView;
  busy: boolean;
  controls?: MenuControls;
}) {
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
        <PublicationEffect effect={props.publication.result?.effect} controls={props.controls} />
      </div>
    </Show>
  );
}
