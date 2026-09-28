import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import "./chat-ci-details.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-controller.ts";
import "../../../components/tooltip.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import {
  renderGitHubPublicationAction,
  renderGitHubPublicationDetails,
} from "./chat-github-publication.ts";

const DISMISSED_STORAGE_KEY = "openclaw.chat.dismissedPullRequests";
// Bounds localStorage growth: dismissals for the oldest sessions fall off
// once this many sessions have dismissed chips.
const DISMISSED_SESSION_LIMIT = 20;

export function chatPullRequestId(pullRequest: ControlUiSessionPullRequest): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`.toLowerCase();
}

function readDismissedStore(storage: Storage): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DISMISSED_STORAGE_KEY) ?? "{}");
    if (!isRecord(parsed)) {
      return {};
    }
    const store: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter((id): id is string => typeof id === "string");
      }
    }
    return store;
  } catch {
    return {};
  }
}

export function listDismissedChatPullRequests(sessionKey: string): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set();
  }
  return new Set(readDismissedStore(storage)[sessionKey] ?? []);
}

export function dismissChatPullRequest(
  sessionKey: string,
  pullRequest: ControlUiSessionPullRequest,
): ReadonlySet<string> {
  const storage = getSafeLocalStorage();
  if (!storage || !sessionKey) {
    return new Set([chatPullRequestId(pullRequest)]);
  }
  const store = readDismissedStore(storage);
  const ids = new Set(store[sessionKey] ?? []);
  ids.add(chatPullRequestId(pullRequest));
  delete store[sessionKey];
  store[sessionKey] = [...ids];
  const staleSessions = Object.keys(store).slice(0, -DISMISSED_SESSION_LIMIT);
  for (const staleKey of staleSessions) {
    delete store[staleKey];
  }
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota or privacy-mode failures only cost re-showing dismissed chips.
  }
  return ids;
}

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

function renderChecksRow(label: string, count: number, modifier: string) {
  if (count === 0) {
    return nothing;
  }
  return html`
    <div class="chat-pr__checks-row chat-pr__checks-row--${modifier}">
      <span class="chat-pr__checks-row-dot" aria-hidden="true"></span>
      <span class="chat-pr__checks-row-label">${label}</span>
      <span class="chat-pr__checks-row-count">${count}</span>
    </div>
  `;
}

function renderChecks(
  pullRequest: ControlUiSessionPullRequest,
  props: { gateway?: ApplicationGateway; sessionKey?: string; presented?: boolean },
) {
  const checks = pullRequest.checks;
  if (!checks) {
    return nothing;
  }
  const label = t(CHECK_LABEL_KEYS[checks.state]);
  const syncChecksOverlay = (element: EventTarget | null | undefined) => {
    if (!(element instanceof HTMLDetailsElement)) {
      return;
    }
    syncAnchoredOverlay(element, "top", { alignment: "end" });
    const popup = element.querySelector<WaPopup>(":scope > wa-popup[data-anchored-overlay]");
    if (popup && props.presented === false) {
      popup.active = false;
    }
  };
  return html`
    <details
      class="chat-pr__checks"
      data-checks=${checks.state}
      ${ref(syncChecksOverlay)}
      @toggle=${(event: Event) => syncChecksOverlay(event.currentTarget)}
    >
      <summary class="chat-pr__checks-pill" aria-label=${label} title=${label}>
        <span class="chat-pr__checks-dot" aria-hidden="true"></span>
        ${t("chat.pullRequests.checks")}
        <span class="chat-pr__checks-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-pr__checks-menu"
          role="group"
          aria-label=${t("chat.pullRequests.ciMonitoring")}
        >
          <div class="chat-pr__checks-menu-header">
            <span>${t("chat.pullRequests.ciMonitoring")}</span>
            <a
              href=${pullRequest.checksUrl ?? pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${t("chat.pullRequests.openChecks")}
            >
              ${icons.externalLink}
            </a>
          </div>
          <div class="chat-pr__checks-counts">
            ${renderChecksRow(t("chat.pullRequests.checksPassed"), checks.passed, "passed")}
            ${renderChecksRow(t("chat.pullRequests.checksFailed"), checks.failed, "failed")}
            ${renderChecksRow(t("chat.pullRequests.checksRunning"), checks.running, "running")}
            ${renderChecksRow(t("chat.pullRequests.checksSkipped"), checks.skipped, "skipped")}
          </div>
          <openclaw-chat-ci-details
            .pullRequest=${pullRequest}
            .gateway=${props.gateway}
            .sessionKey=${props.sessionKey ?? ""}
            .presented=${props.presented ?? true}
          ></openclaw-chat-ci-details>
        </div>
      </wa-popup>
    </details>
  `;
}

function renderDiffStats(
  item: { additions?: number; deletions?: number },
  onOpenSessionDiff?: () => void,
) {
  if (typeof item.additions !== "number" && typeof item.deletions !== "number") {
    return nothing;
  }
  const additions = html`<span class="chat-pr__additions"
    >+${(item.additions ?? 0).toLocaleString()}</span
  >`;
  const deletions = html`<span class="chat-pr__deletions"
    >−${(item.deletions ?? 0).toLocaleString()}</span
  >`;
  if (onOpenSessionDiff) {
    return html`
      <button
        class="chat-pr__diff"
        type="button"
        aria-label=${t("chat.sessionDiff.show")}
        @click=${onOpenSessionDiff}
      >
        ${additions} ${deletions}
      </button>
    `;
  }
  return html` <span class="chat-pr__diff">${additions} ${deletions}</span> `;
}

function renderStatusWarning(status: ControlUiSessionPullRequestSnapshot["status"]) {
  if (status === "ready") {
    return nothing;
  }
  const message = t(
    status === "rate-limited" ? "chat.pullRequests.rateLimited" : "chat.pullRequests.unavailable",
  );
  return html`
    <openclaw-tooltip content=${message}>
      <span class="chat-pr__warning" role="img" aria-label=${message}>
        ${icons.alertTriangle}
      </span>
    </openclaw-tooltip>
  `;
}

function renderCreatePullRequestLink(branch: ControlUiSessionBranch) {
  return branch.createUrl
    ? html`
        <a
          class="chat-pr__create"
          href=${branch.createUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label=${t("chat.pullRequests.createPrLabel", { branch: branch.branch })}
        >
          ${t("chat.pullRequests.createPr")}
        </a>
      `
    : nothing;
}

// Pre-PR state: the branch row mirrors PR chips and offers Gateway-owned
// publication when available. When status is stale, "no PR found" is unreliable,
// so the warning stays visible here.
function renderWorkRow(
  branch: ControlUiSessionBranch | undefined,
  status: ControlUiSessionPullRequestSnapshot["status"],
  onOpenSessionDiff?: () => void,
  publication?: GitHubPublicationView,
) {
  const published =
    !branch && publication?.result?.status === "published" ? publication.result : undefined;
  return html`
    <article
      class="chat-pr"
      data-state=${published ? "published" : branch ? "branch" : "publication"}
    >
      <span class="chat-pr__link chat-pr__link--static">
        <span class="chat-pr__icon" aria-hidden="true"
          >${published || !branch ? icons.gitPullRequest : icons.gitBranch}</span
        >
        <span class="chat-pr__identity">
          <span class="chat-pr__repo"
            >${published?.repository ?? branch?.repo ?? t("chat.pullRequests.publishPr")}</span
          >
          <span class="chat-pr__branch">${published?.branch ?? branch?.branch}</span>
        </span>
      </span>
      <span class="chat-pr__meta">
        ${branch && !published ? renderDiffStats(branch, onOpenSessionDiff) : nothing}
        ${renderStatusWarning(status)}
        ${
          publication
            ? renderGitHubPublicationAction(publication)
            : branch
              ? renderCreatePullRequestLink(branch)
              : nothing
        }
      </span>
      ${publication ? renderGitHubPublicationDetails(publication) : nothing}
    </article>
  `;
}

export function renderChatPullRequests(props: {
  pullRequests: ControlUiSessionPullRequest[];
  gateway?: ApplicationGateway;
  sessionKey?: string;
  presented?: boolean;
  branch?: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onDismiss: (pullRequest: ControlUiSessionPullRequest) => void;
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
}) {
  const { publication } = props;
  const published = publication?.result?.status === "published" ? publication.result : undefined;
  const retainedPublication = publication?.result || publication?.locked || publication?.error;
  // Gateway branch facts describe unpublished work, including changes after a merge.
  // PR metadata takes precedence over retained publication history.
  if (props.branch || (props.pullRequests.length === 0 && retainedPublication)) {
    return html`<div class="chat-prs" aria-live="polite">
      ${renderWorkRow(props.branch, props.status, props.onOpenSessionDiff, publication)}
    </div>`;
  }
  if (props.pullRequests.length === 0) {
    return nothing;
  }
  const recovery =
    retainedPublication && (!published || publication?.error) ? publication : undefined;
  const visible = [
    ...props.pullRequests.filter((item) => item.state === "open" || item.state === "draft"),
    ...props.pullRequests.filter((item) => item.state !== "open" && item.state !== "draft"),
  ];
  return html`
    <div class="chat-prs" aria-live="polite">
      ${repeat(visible, chatPullRequestId, (pullRequest) => {
        const merged = pullRequest.state === "merged";
        const rowPublication = pullRequest === visible[0] ? recovery : undefined;
        return html`
          <article class="chat-pr" data-state=${pullRequest.state}>
            <a
              class="chat-pr__link"
              href=${pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${t("chat.pullRequests.linkLabel", {
                number: String(pullRequest.number),
                title: pullRequest.title,
              })}
            >
              <span class="chat-pr__icon" aria-hidden="true">
                ${merged ? icons.gitMerge : icons.gitPullRequest}
              </span>
              <span class="chat-pr__number">#${pullRequest.number}</span>
              <span class="chat-pr__identity">
                <span class="chat-pr__repo">${pullRequest.repo}</span>
                <span class="chat-pr__branch">${pullRequest.branch}</span>
              </span>
            </a>
            <span class="chat-pr__meta">
              ${renderDiffStats(pullRequest)} ${renderChecks(pullRequest, props)}
              ${
                pullRequest.state === "open"
                  ? nothing
                  : html`<span class="chat-pr__state"
                      >${t(STATE_LABEL_KEYS[pullRequest.state])}</span
                    >`
              }
              ${!merged || props.status === "unavailable" ? renderStatusWarning(props.status) : nothing}
              ${rowPublication && !published ? renderGitHubPublicationAction(rowPublication) : nothing}
              <button
                class="chat-pr__dismiss"
                type="button"
                ?disabled=${Boolean(published) && publication?.activity !== null}
                aria-label=${t("chat.pullRequests.dismiss", {
                  number: String(pullRequest.number),
                })}
                @click=${() => {
                  if (published) {
                    publication?.onNewAction?.();
                  }
                  props.onDismiss(pullRequest);
                }}
              >
                ${icons.x}
              </button>
            </span>
            ${rowPublication ? renderGitHubPublicationDetails(rowPublication) : nothing}
          </article>
        `;
      })}
    </div>
  `;
}
