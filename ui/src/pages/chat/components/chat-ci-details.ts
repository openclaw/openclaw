import { html, nothing, svg, type PropertyValues } from "lit";
import { property, state as reactiveState } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequestCheckStep,
} from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

registerChatCiEnglish();

const REFRESH_MS = 30_000;
const SKIPPED_ICON = strokeIcon(svg`<circle cx="12" cy="12" r="10" /><path d="M8 12h8" />`);
const CHECK_ORDER = { failed: 0, running: 1, passed: 2, skipped: 3 } as const;
type CheckState = ControlUiSessionPullRequestCheck["state"] | "queued";

function stepState(step: ControlUiSessionPullRequestCheckStep): CheckState {
  if (step.status === "in_progress") {
    return "running";
  }
  switch (step.conclusion) {
    case "success":
      return "passed";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failed";
    case "skipped":
    case "neutral":
    case "cancelled":
      return "skipped";
    default:
      return "queued";
  }
}

const STATE_LABEL_KEYS = {
  passed: "chat.pullRequests.checksPassed",
  failed: "chat.pullRequests.checksFailed",
  running: "chat.pullRequests.checksRunning",
  skipped: "chat.pullRequests.checksSkipped",
  queued: "chat.pullRequests.checksQueued",
} as const;

function renderStatus(state: CheckState) {
  const label = t(STATE_LABEL_KEYS[state]);
  const icon =
    state === "passed"
      ? icons.check
      : state === "failed"
        ? icons.circleX
        : state === "running"
          ? icons.loader
          : state === "skipped"
            ? SKIPPED_ICON
            : icons.clock;
  return html`<span
    class="chat-ci__status"
    data-state=${state}
    role="img"
    aria-label=${label}
    title=${label}
    >${icon}</span
  >`;
}

function duration(item: { startedAt?: string; completedAt?: string }, running: boolean): string {
  const start = item.startedAt ? Date.parse(item.startedAt) : Number.NaN;
  const end = item.completedAt ? Date.parse(item.completedAt) : running ? Date.now() : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? (formatDurationCompact(end - start) ?? "")
    : "";
}

/** Presentation-only details: the Gateway owns GitHub discovery, joins, and caching. */
export class ChatCiDetailsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) pullRequest?: ControlUiSessionPullRequest;
  @property({ attribute: false }) gateway?: ApplicationGateway;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) presented = true;
  @reactiveState() private loading = false;
  @reactiveState() private result?: ControlUiSessionPullRequestCheckDetails;
  @reactiveState() private error: string | null = null;

  private disclosure: HTMLDetailsElement | null = null;
  private stopGateway?: () => void;
  private boundGateway?: ApplicationGateway;
  private readonly connection = createGatewayConnectionLifecycle({
    client: null,
    phase: "stopped",
  });
  private target = "";
  private requestGeneration = 0;
  private requestController?: AbortController;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private retryAt = 0;
  private readonly expandedJobs = new Map<number, boolean>();
  private expansionInitialized = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.disclosure = this.closest<HTMLDetailsElement>(".chat-pr__checks");
    this.disclosure?.addEventListener("toggle", this.handleToggle);
    this.ownerDocument.addEventListener("visibilitychange", this.handleVisibility);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.disclosure?.removeEventListener("toggle", this.handleToggle);
    this.ownerDocument.removeEventListener("visibilitychange", this.handleVisibility);
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.boundGateway = undefined;
    this.connection.transition({ client: null, phase: "stopped" });
    this.reset();
    super.disconnectedCallback();
  }

  private targetKey(): string {
    const pr = this.pullRequest;
    return JSON.stringify([this.sessionKey, pr?.owner, pr?.repo, pr?.number, pr?.headSha]);
  }

  private get visible(): boolean {
    return (
      this.isConnected &&
      this.presented &&
      this.disclosure?.open === true &&
      this.ownerDocument.visibilityState !== "hidden"
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const target = this.targetKey();
    if (target !== this.target) {
      // Head changes refresh the same open monitor; session changes dismiss it.
      if (changed.has("sessionKey") && changed.get("sessionKey") && this.disclosure) {
        this.disclosure.open = false;
      }
      this.target = target;
      this.reset();
    }
    if (this.boundGateway !== this.gateway) {
      this.stopGateway?.();
      this.boundGateway = this.gateway;
      this.connection.transition(this.gateway?.snapshot ?? { client: null, phase: "stopped" });
      this.reset();
      this.stopGateway = this.gateway?.subscribe((snapshot) => {
        if (this.connection.transition(snapshot)) {
          this.reset();
          void this.load();
        }
      });
    }
    if (!this.visible) {
      this.cancelRequest();
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (
      changed.has("pullRequest") ||
      changed.has("gateway") ||
      changed.has("sessionKey") ||
      changed.has("presented")
    ) {
      if (
        this.visible &&
        !this.loading &&
        (changed.has("presented") || (!this.result && !this.error))
      ) {
        void this.load();
      }
    }
  }

  private cancelRequest(): void {
    this.requestGeneration += 1;
    this.requestController?.abort();
    this.requestController = undefined;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.loading = false;
  }

  private reset(): void {
    this.cancelRequest();
    this.result = undefined;
    this.error = null;
    this.retryAt = 0;
    this.expandedJobs.clear();
    this.expansionInitialized = false;
  }

  private readonly handleToggle = (event: Event): void => {
    if (event.target !== this.disclosure) {
      return;
    }
    this.handleVisibility();
  };

  private readonly handleVisibility = (): void => {
    if (this.visible) {
      void this.load();
    } else {
      this.cancelRequest();
    }
  };

  private async load(): Promise<void> {
    if (!this.visible || this.loading) {
      return;
    }
    if (Date.now() < this.retryAt) {
      this.scheduleRetryAvailability();
      return;
    }
    const pr = this.pullRequest;
    const gateway = this.gateway;
    const scope = this.connection.capture();
    if (!scope || !gateway || !pr?.headSha || !this.sessionKey) {
      this.error = t("chat.pullRequests.checksUnavailable");
      return;
    }
    clearTimeout(this.refreshTimer);
    const generation = ++this.requestGeneration;
    const target = this.targetKey();
    const connectionGeneration = scope.client.connectionGeneration;
    const connectionRevision = gateway.connectionRevision;
    const controller = new AbortController();
    this.requestController = controller;
    this.loading = true;
    this.error = null;
    const current = () =>
      this.visible &&
      generation === this.requestGeneration &&
      target === this.targetKey() &&
      gateway === this.gateway &&
      gateway.connectionRevision === connectionRevision &&
      gateway.snapshot.client === scope.client &&
      gateway.snapshot.phase === "connected" &&
      this.connection.isCurrent(scope) &&
      scope.client.connectionGeneration === connectionGeneration;
    try {
      const result = await scope.client.request<ControlUiSessionPullRequestCheckDetails>(
        "controlUi.sessionPullRequests.checks",
        {
          sessionKey: this.sessionKey,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
        },
        { signal: controller.signal },
      );
      if (!current()) {
        return;
      }
      if (
        result.owner.toLowerCase() !== pr.owner.toLowerCase() ||
        result.repo.toLowerCase() !== pr.repo.toLowerCase() ||
        result.number !== pr.number ||
        result.headSha !== pr.headSha
      ) {
        this.result = undefined;
        this.error = t("chat.pullRequests.checksUnavailable");
        return;
      }
      this.result = result;
      this.retryAt =
        Date.now() + Math.max(0, result.retryAfterMs ?? (result.rateLimited ? 60_000 : 0));
      if (!this.expansionInitialized && result.checks.length > 0) {
        this.expansionInitialized = true;
        const first = result.checks
          .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state])
          .find((check) => check.state === "failed" || check.state === "running");
        if (first) {
          this.expandedJobs.set(first.id, true);
        }
      }
      const ids = new Set(result.checks.map((check) => check.id));
      for (const id of this.expandedJobs.keys()) {
        if (!ids.has(id)) {
          this.expandedJobs.delete(id);
        }
      }
      if (this.retryAt > Date.now()) {
        this.scheduleRetryAvailability();
      } else if (result.status === "ready") {
        // Completed jobs can be rerun on the same head without changing the
        // summary counts. Poll only the visible monitor, even after completion.
        this.refreshTimer = setTimeout(() => void this.load(), REFRESH_MS);
      }
    } catch (error) {
      if (current()) {
        // Only explicit stale responses authorize retaining previous details.
        this.result = undefined;
        this.error = formatUiError(error, t("chat.pullRequests.checksUnavailable"));
      }
    } finally {
      if (current()) {
        this.loading = false;
        this.requestController = undefined;
      }
    }
  }

  private scheduleRetryAvailability(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => this.requestUpdate(),
      Math.min(2_147_483_647, Math.max(0, this.retryAt - Date.now())),
    );
  }

  private renderNotice() {
    const result = this.result;
    const limited = result?.rateLimited;
    const stale = result?.status === "stale";
    const unavailable = this.error || result?.status === "unavailable";
    const incomplete = Boolean(result?.error);
    if (this.loading && !result) {
      return html`<div class="chat-ci__notice" role="status">
        ${t("chat.pullRequests.checksLoading")}
      </div>`;
    }
    if (!limited && !stale && !unavailable && !incomplete) {
      return nothing;
    }
    const retryWait = Math.max(0, this.retryAt - Date.now());
    return html`<div
      class="chat-ci__notice"
      role="status"
      data-state=${limited ? "rate-limited" : "unavailable"}
    >
      <span
        >${
          this.error ??
          (limited
            ? t("chat.pullRequests.checksRateLimited")
            : stale
              ? t("chat.pullRequests.checksStale")
              : t("chat.pullRequests.checksUnavailable"))
        }
        ${retryWait > 0 ? t("chat.pullRequests.checksRetryAfter", { duration: formatDurationCompact(retryWait) ?? "" }) : nothing}
      </span>
      <button
        class="chat-ci__retry"
        type="button"
        ?disabled=${this.loading || retryWait > 0}
        @click=${() => void this.load()}
      >
        ${t("common.retry")}
      </button>
    </div>`;
  }

  private renderJob(check: ControlUiSessionPullRequestCheck) {
    const detailsUrl = check.detailsUrl
      ? resolveSafeExternalUrl(check.detailsUrl, this.ownerDocument.baseURI)
      : null;
    const jobState: CheckState =
      check.state === "running" && check.status !== "in_progress" ? "queued" : check.state;
    return html`<details
      class="chat-ci__job"
      data-state=${check.state}
      data-check-id=${check.id}
      .open=${this.expandedJobs.get(check.id) ?? false}
      @toggle=${(event: Event) => {
        if (!(event.target instanceof HTMLDetailsElement) || event.target !== event.currentTarget) {
          return;
        }
        this.expandedJobs.set(check.id, event.target.open);
        this.requestUpdate();
      }}
    >
      <summary class="chat-ci__job-summary">
        ${renderStatus(jobState)}
        <span class="chat-ci__name">${check.name}</span>
        <span class="chat-ci__duration">${duration(check, jobState === "running")}</span>
        <span class="chat-ci__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <div class="chat-ci__job-detail">
        ${
          check.steps?.length
            ? html`<ol class="chat-ci__steps" role="list">
                ${repeat(
                  check.steps.toSorted((a, b) => a.number - b.number),
                  (step) => step.number,
                  (step) => {
                    const state = stepState(step);
                    return html`<li class="chat-ci__step" data-state=${state} value=${step.number}>
                      ${renderStatus(state)}<span class="chat-ci__name">${step.name}</span>
                      <span class="chat-ci__duration">${duration(step, state === "running")}</span>
                    </li>`;
                  },
                )}
              </ol>`
            : html`<div class="chat-ci__empty-steps">
                ${
                  check.source === "check"
                    ? t("chat.pullRequests.checksNoSteps")
                    : t("chat.pullRequests.checksStepsUnavailable")
                }
              </div>`
        }
        ${
          detailsUrl
            ? html`<a
                class="chat-ci__job-link"
                href=${detailsUrl}
                target="_blank"
                rel="noopener noreferrer"
                >${check.source === "actions" ? t("chat.pullRequests.openJob") : t("chat.pullRequests.openCheck")}${icons.externalLink}</a
              >`
            : nothing
        }
      </div>
    </details>`;
  }

  override render() {
    const checks = this.result?.checks ?? [];
    const jobs = checks
      .filter((check) => check.state !== "skipped")
      .toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
    const skipped = checks.filter((check) => check.state === "skipped");
    return html`${this.renderNotice()}
      <div class="chat-ci__jobs" aria-busy=${this.loading ? "true" : "false"}>
        ${repeat(
          jobs,
          (check) => check.id,
          (check) => this.renderJob(check),
        )}
        ${
          skipped.length
            ? html`<details class="chat-ci__skipped">
                <summary>
                  ${renderStatus("skipped")}<span
                    >${t("chat.pullRequests.checksSkippedCount", { count: String(skipped.length) })}</span
                  >
                  <span class="chat-ci__chevron" aria-hidden="true">${icons.chevronDown}</span>
                </summary>
                ${repeat(
                  skipped,
                  (check) => check.id,
                  (check) => this.renderJob(check),
                )}
              </details>`
            : nothing
        }
        ${
          this.result?.status === "ready" &&
          !checks.length &&
          !this.result.rateLimited &&
          !this.result.error
            ? html`<div class="chat-ci__notice">${t("chat.pullRequests.checksEmpty")}</div>`
            : nothing
        }
      </div>`;
  }
}

if (!customElements.get("openclaw-chat-ci-details")) {
  customElements.define("openclaw-chat-ci-details", ChatCiDetailsElement);
}
