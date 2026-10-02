import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
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

function renderPublicationRefresh(publication: GitHubPublicationView) {
  return html`<button class="btn btn--sm" type="button" @click=${publication.onRefresh}>
    ${t("githubPublication.refresh")}
  </button>`;
}

export function renderGitHubPublicationDetails(publication: GitHubPublicationView) {
  const { result, confirmation, activity, locked, error, options } = publication;
  const selection = publicationButtonSelection(publication);
  if (result?.status === "published" && !error) {
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
  return html`<div class="chat-pr__publication-outcome" data-state=${result?.status ?? "selection"}>
    ${result || locked || error ? renderPublicationAccount(publication) : nothing}
    ${noAccount ? html`<span>${t(options.personal === null ? "githubPublication.unidentified" : "githubPublication.connectHelp")}</span>` : nothing}
    ${
      result && result.status !== "published"
        ? html`<span role="status">${result.message}</span>`
        : nothing
    }
    ${result?.status === "failed" ? html`<span>${result.nextAction}</span>` : nothing}
    ${error ? html`<span role="alert">${error}</span>` : nothing}
    ${locked && !result && !busy ? html`<span>${t("githubPublication.unknown")}</span>` : nothing}
    ${
      confirmation
        ? html`<div>
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
      result?.effect
        ? html`<span
            >${t(
              result.effect.status === "dispatched"
                ? "githubPublication.dispatched"
                : "githubPublication.observed",
              {
                kind: t(
                  result.effect.kind === "push"
                    ? "githubPublication.effectPush"
                    : "githubPublication.effectPullRequest",
                ),
              },
            )}
            ${result.effect.headCommit ? html`<code>${result.effect.headCommit}</code>` : nothing}
            ${
              result.effect.url
                ? html`<a href=${result.effect.url} target="_blank" rel="noopener noreferrer"
                    >${t("githubPublication.effectLink")}</a
                  >`
                : nothing
            }
          </span>`
        : nothing
    }
    ${
      personalUnavailable ? html`<span>${t("githubPublication.personalWorkspace")}</span>` : nothing
    }
    ${
      !busy && (error || (result && !publication.onConfirm && result.status !== "published"))
        ? renderPublicationRefresh(publication)
        : nothing
    }
  </div>`;
}
