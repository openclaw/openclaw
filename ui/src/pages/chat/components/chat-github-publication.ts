import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import {
  personalGitHubPublicationSelection,
  selectedGitHubPublisher,
  type GitHubPublicationView,
} from "../../../lib/sessions/github-publication-controller.ts";

function sourceLabel(source: string): string {
  return t(
    source === "personal"
      ? "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : "githubPublication.system",
  );
}

export function renderGitHubPublicationAction(publication: GitHubPublicationView) {
  if (publication.result?.status === "published") {
    return html`<a
        class="chat-pr__create"
        href=${publication.result.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        ${t("chat.pullRequests.openPublishedPr")}
      </a>
      ${
        publication.onNewAction
          ? html`<button
              class="chat-pr__dismiss"
              type="button"
              aria-label=${t("common.dismiss")}
              ?disabled=${publication.activity !== null}
              @click=${publication.onNewAction}
            >
              ${icons.x}
            </button>`
          : nothing
      }`;
  }
  // Nothing can be published without discovered accounts; offer a retry, not a dead button.
  if (publication.optionsUnavailable) {
    return renderPublicationRefresh(
      publication,
      `${t("githubPublication.statusUnavailable")}: ${publication.error}`,
    );
  }
  const personal = personalGitHubPublicationSelection(publication.options);
  const shared = publication.options?.shared;
  if (publication.result || publication.locked || !publication.onSelect || !shared || !personal) {
    return renderPublicationButton(publication);
  }
  const choices = [
    { source: "shared" as const, account: shared, label: sourceLabel(shared.source) },
    { source: "personal" as const, account: personal.account, label: sourceLabel("personal") },
  ];
  return html`
    ${renderPublicationButton(publication)}
    <wa-dropdown
      class="chat-pr__accounts"
      placement="top-end"
      aria-label=${t("githubPublication.account")}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const source = event.detail.item.value;
        if (source === "shared" || source === "personal") {
          publication.onSelect?.(source);
        }
      }}
    >
      <button
        slot="trigger"
        class="btn btn--ghost btn--icon chat-icon-btn"
        type="button"
        aria-label=${t("githubPublication.account")}
        ?disabled=${publication.activity !== null}
      >
        ${icons.chevronDown}
      </button>
      ${choices.map(({ source, account, label }) => {
        const selected = publication.selection?.source === source;
        return html`
          <wa-dropdown-item
            class="session-menu__item"
            value=${source}
            role="menuitemradio"
            aria-checked=${String(selected)}
            ?disabled=${publication.activity !== null}
            ${ref((element) => syncDropdownItemRadio(element, selected))}
          >
            <span class="session-menu__text"
              >@${account.login}${shared.login === personal.account.login ? html` · ${label}` : nothing}</span
            >
            <span slot="details" class="session-menu__icon" aria-hidden="true">
              ${selected ? icons.check : nothing}
            </span>
          </wa-dropdown-item>
        `;
      })}
    </wa-dropdown>
  `;
}

function publicationButtonSelection(publication: GitHubPublicationView) {
  return (
    publication.selection ??
    (!publication.options?.shared ? personalGitHubPublicationSelection(publication.options) : null)
  );
}

function renderPublicationButton(publication: GitHubPublicationView) {
  const { result, activity } = publication;
  const selection = publicationButtonSelection(publication);
  const busy = activity !== null;
  const pendingLabel = t(activity === "read" ? "common.loading" : "chat.pullRequests.publishing");
  let action: { click: (() => void) | undefined; label: string; disabled: boolean };
  if (result?.status === "failed") {
    action = {
      click: publication.onNewAction,
      label: t(
        publication.canPublishShared || publication.canPublishPersonal
          ? "githubPublication.newAction"
          : "common.dismiss",
      ),
      disabled: busy,
    };
  } else if (result?.status === "needs_confirmation") {
    action = {
      click: publication.onConfirm,
      label: t("githubPublication.confirm"),
      disabled: busy || !publication.personalReady,
    };
  } else if (result?.status === "publishing" || result?.status === "requested") {
    action = {
      click: publication.onRefresh,
      label: busy ? pendingLabel : t("githubPublication.check"),
      disabled: busy,
    };
  } else {
    action = {
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
  }
  // Accepted shared requests retain their status button even when no replay callback is available.
  return action.click || result?.status === "publishing" || result?.status === "requested"
    ? html`<button
        class="chat-pr__create"
        type="button"
        ?disabled=${action.disabled}
        @click=${action.click}
      >
        ${action.label}
      </button>`
    : nothing;
}

function renderPublicationAccount(publication: GitHubPublicationView) {
  const { selection, result } = publication;
  const publisher = result ? result.publisher : selectedGitHubPublisher(selection);
  return publisher
    ? html`<span data-publication-account>
        ${t("githubPublication.publishAs", { account: publisher.login })} ·
        ${sourceLabel(publisher.source)}
      </span>`
    : nothing;
}

function renderPublicationRefresh(publication: GitHubPublicationView, tooltip?: string) {
  const label = t("githubPublication.refresh");
  return html`<openclaw-tooltip content=${tooltip ?? label}>
    <button
      class="btn btn--ghost btn--icon chat-icon-btn chat-pr__publication-refresh"
      type="button"
      aria-label=${label}
      @click=${publication.onRefresh}
    >
      ${icons.refresh}
    </button>
  </openclaw-tooltip>`;
}

function renderPublicationEffect(effect: NonNullable<GitHubPublicationView["result"]>["effect"]) {
  if (!effect) {
    return nothing;
  }
  return html`<span
    >${t(
      effect.status === "dispatched"
        ? "githubPublication.dispatched"
        : "githubPublication.observed",
      {
        kind: t(
          effect.kind === "push"
            ? "githubPublication.effectPush"
            : "githubPublication.effectPullRequest",
        ),
      },
    )}
    ${effect.headCommit ? html`<code>${effect.headCommit}</code>` : nothing}
    ${
      effect.url
        ? html`<a href=${effect.url} target="_blank" rel="noopener noreferrer"
            >${t("githubPublication.effectLink")}</a
          >`
        : nothing
    }
  </span>`;
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

/** `inline` renders details without their own disclosure when the caller already owns one. */
export function renderGitHubPublicationDetails(
  publication: GitHubPublicationView,
  { inline = false } = {},
) {
  const { result, confirmation, activity, locked, error, options } = publication;
  const selection = publicationButtonSelection(publication);
  // The row action already carries the retry and the reason.
  if ((result?.status === "published" && !error) || publication.optionsUnavailable) {
    return nothing;
  }
  const busy = activity !== null;
  const personalUnavailable = selection?.source === "personal" && !publication.personalReady;
  const noAccount =
    options &&
    !options.shared &&
    !personalGitHubPublicationSelection(options) &&
    !selection &&
    !result &&
    !locked &&
    !busy &&
    (publication.canPublishShared || publication.canPublishPersonal);
  if (!result && !confirmation && !error && !locked && !personalUnavailable && !noAccount) {
    return nothing;
  }
  const headline = publicationHeadline(publication, busy);
  // Accepted requests already offer "Check publication" as their primary action.
  const refresh =
    !busy &&
    (error ||
      result?.status === "failed" ||
      (result?.status === "needs_confirmation" && !publication.onConfirm));
  const more =
    result || locked || error
      ? html`<div class="chat-pr__publication-more">
          ${renderPublicationAccount(publication)}
          ${result && result.status !== "published" && result.status !== "failed" ? html`<span>${result.message}</span>` : nothing}
          ${result?.status === "failed" ? html`<span>${result.nextAction}</span>` : nothing}
          ${error ? html`<span>${error}</span>` : nothing}
          ${locked && !result && !busy ? html`<span>${t("githubPublication.unknown")}</span>` : nothing}
          ${renderPublicationEffect(result?.effect)}
        </div>`
      : nothing;
  return html`<div class="chat-pr__publication-outcome" data-state=${result?.status ?? "selection"}>
    ${
      inline
        ? more
        : headline
          ? html`<details class="chat-pr__publication-status">
              <summary>
                <span
                  class="chat-pr__publication-headline"
                  role=${headline.alert ? "alert" : "status"}
                  >${headline.text}</span
                >
                <span class="chat-pr__publication-chevron" aria-hidden="true"
                  >${icons.chevronDown}</span
                >
              </summary>
              ${more}
            </details>`
          : nothing
    }
    ${refresh ? renderPublicationRefresh(publication) : nothing}
    ${noAccount ? html`<span class="chat-pr__publication-note">${t(options.personal === null ? "githubPublication.unidentified" : "githubPublication.connectHelp")}</span>` : nothing}
    ${
      confirmation
        ? html`<div class="chat-pr__publication-note">
            <div>
              ${t("githubPublication.target", {
                repository: confirmation.repository,
                base: confirmation.baseBranch,
              })}
            </div>
            <div>
              ${t("githubPublication.pushTarget", {
                repository: confirmation.pushRepository,
                branch: confirmation.branch,
              })}
            </div>
            <details>
              <summary>${t("githubPublication.snapshot")}</summary>
              <div>
                ${t("githubPublication.head")}: <code>${confirmation.sourceHeadCommit}</code>
              </div>
              <div>
                ${t("githubPublication.index")}: <code>${confirmation.sourceIndexTree}</code>
              </div>
              <div>
                ${t("githubPublication.workspace")}: <code>${confirmation.workspaceTree}</code>
              </div>
            </details>
          </div>`
        : nothing
    }
    ${
      personalUnavailable
        ? html`<span class="chat-pr__publication-note"
            >${t("githubPublication.personalWorkspace")}</span
          >`
        : nothing
    }
  </div>`;
}
