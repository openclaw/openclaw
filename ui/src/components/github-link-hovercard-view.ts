import { html, nothing, render, type TemplateResult } from "lit";
import type { ControlUiGitHubPreview } from "../../../src/gateway/control-ui-contract.js";
import { t } from "../i18n/index.ts";
import { registerGitHubPreviewEnglish } from "../i18n/locales/en-github-preview.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { gitHubProfileUrl, type GitHubLinkTarget } from "./github-link-target.ts";

registerGitHubPreviewEnglish();

type GitHubPreviewDetails = Omit<ControlUiGitHubPreview, "createdAt" | "updatedAt" | "login"> & {
  updatedAt?: string;
  login?: string;
};
export type GitHubPreview = GitHubLinkTarget & GitHubPreviewDetails;

type PreviewState = {
  state: "merged" | "draft" | "open" | "closed" | "not-planned";
  label: string;
  tone: "danger" | "muted" | "open" | "purple";
};

export function previewState(preview: GitHubPreviewDetails): PreviewState {
  if (preview.kind === "pull") {
    if (preview.mergedAt || preview.state === "merged") {
      return { state: "merged", label: t("githubPreview.states.merged"), tone: "purple" };
    }
    if (preview.draft && preview.state === "open") {
      return { state: "draft", label: t("githubPreview.states.draft"), tone: "muted" };
    }
    return preview.state === "open"
      ? { state: "open", label: t("githubPreview.states.open"), tone: "open" }
      : { state: "closed", label: t("githubPreview.states.closed"), tone: "danger" };
  }
  if (preview.state === "open") {
    return { state: "open", label: t("githubPreview.states.open"), tone: "open" };
  }
  return preview.stateReason === "not_planned"
    ? { state: "not-planned", label: t("githubPreview.states.notPlanned"), tone: "muted" }
    : { state: "closed", label: t("githubPreview.states.closed"), tone: "purple" };
}

function renderAvatar(dataUrl: string | undefined) {
  return dataUrl
    ? html`<img
        class="github-link-hovercard__avatar"
        alt=""
        decoding="async"
        referrerpolicy="no-referrer"
        src=${dataUrl}
      />`
    : nothing;
}

function renderCoAuthors(preview: GitHubPreview) {
  const coAuthors = preview.coAuthors ?? [];
  const total = preview.coAuthorCount ?? coAuthors.length;
  if (coAuthors.length === 0) {
    return nothing;
  }
  // Counted from rendered faces, not fetched people: avatar inlining is optional,
  // and a co-author with no face must fall into "+N" rather than disappear.
  const faces = coAuthors.filter((coAuthor) => coAuthor.avatarDataUrl).length;
  const hidden = Math.max(0, total - faces);
  if (faces === 0 && hidden === 0) {
    return nothing;
  }
  const label = t("githubPreview.coAuthors", {
    logins: coAuthors.map((coAuthor) => coAuthor.login).join(", "),
  });
  return html`<span
    class="github-link-hovercard__coauthors"
    title=${label}
    role="img"
    aria-label=${label}
    >${coAuthors.map((coAuthor) => renderAvatar(coAuthor.avatarDataUrl))}${
      hidden > 0
        ? html`<span class="github-link-hovercard__coauthors-more">+${hidden}</span>`
        : nothing
    }</span
  >`;
}

function renderCardLink(className: string, href: string, content: string | TemplateResult) {
  return html`<a
    class=${className}
    href=${href}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    >${content}</a
  >`;
}

export function renderGitHubPreviewLoading(card: HTMLDivElement): void {
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  card.removeAttribute("data-cached");
  card.setAttribute("aria-label", t("githubPreview.loading"));
  const rows = [
    ["header", ["badge", "repo", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metrics"]],
  ] as const;
  render(
    html`<div class="github-link-hovercard__skeleton" aria-hidden="true">
      ${rows.map(
        ([rowClass, parts]) => html`<div class=${`github-link-hovercard__${rowClass}`}>
          ${parts.map((part) => html`<span class=${`skeleton github-link-hovercard__placeholder--${part}`}></span>`)}
        </div>`,
      )}
    </div>`,
    card,
  );
}

export function renderGitHubPreview(
  card: HTMLDivElement,
  preview: GitHubPreview,
  seeded = false,
): void {
  card.dataset.loading = "false";
  card.dataset.cached = String(seeded);
  const state = previewState(preview);
  card.dataset.state = state.tone;
  const comments = preview.comments ?? 0;
  render(
    html`<div class="github-link-hovercard__header">
        <span class="github-link-hovercard__state" data-tone=${state.tone}
          ><span class="github-link-hovercard__state-dot" aria-hidden="true"></span
          >${state.label}</span
        >
        ${renderCardLink(
          "github-link-hovercard__repo",
          preview.href,
          `${preview.owner}/${preview.repo} #${preview.number}`,
        )}
        ${
          seeded
            ? html`<span class="github-link-hovercard__time">${t("githubPreview.cached")}</span>`
            : preview.updatedAt
              ? html`<time class="github-link-hovercard__time"
                  >${formatRelativeTimestamp(Date.parse(preview.updatedAt))}</time
                >`
              : nothing
        }
      </div>
      ${renderCardLink("github-link-hovercard__title", preview.href, preview.title)}
      <div class="github-link-hovercard__footer">
        ${
          preview.login
            ? renderCardLink(
                "github-link-hovercard__author",
                gitHubProfileUrl(preview.login),
                html`${renderAvatar(preview.avatarDataUrl)}${preview.login}`,
              )
            : nothing
        }${renderCoAuthors(preview)}
        ${
          preview.kind === "pull"
            ? html`<span
                class="github-link-hovercard__metrics github-link-hovercard__metrics--diff"
              >
                ${
                  preview.additions !== undefined || !seeded
                    ? html`<span
                        class="github-link-hovercard__metric github-link-hovercard__metric--additions"
                        >+${preview.additions ?? 0}</span
                      >`
                    : nothing
                }
                ${
                  preview.deletions !== undefined || !seeded
                    ? html`<span
                        class="github-link-hovercard__metric github-link-hovercard__metric--deletions"
                        >−${preview.deletions ?? 0}</span
                      >`
                    : nothing
                }
              </span>`
            : html`<span class="github-link-hovercard__metrics">
                <span class="github-link-hovercard__metric"
                  >${t(comments === 1 ? "githubPreview.comment" : "githubPreview.comments", {
                    count: String(comments),
                  })}</span
                >
              </span>`
        }
      </div>`,
    card,
  );
  card.setAttribute(
    "aria-label",
    t(preview.login ? "githubPreview.ariaLabel" : "githubPreview.ariaLabelWithoutAuthor", {
      state: state.label,
      kind: preview.kind === "pull" ? t("githubPreview.pullRequest") : t("githubPreview.issue"),
      repo: `${preview.owner}/${preview.repo}`,
      number: String(preview.number),
      title: preview.title,
      author: preview.login ?? "",
    }),
  );
}
