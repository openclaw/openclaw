import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { createInitialCronState } from "../../../lib/cron/index.ts";
import { loadCompactCronJobsPage } from "../../../lib/cron/jobs.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { resolveUiConversationIdentity } from "../../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import "../../../styles/chat/summary-automations.css";
import "./chat-summary-overflow.ts";

/** Session-scoped read-only projection of the existing automation inventory owner. */
export class ChatSummaryAutomationsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) gateway?: ApplicationGateway;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) presented = true;
  @property({ attribute: false }) onNavigate?: (jobId: string) => void;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @state() private cron = createInitialCronState<CronCompactJob>();
  @state() private showError = false;

  private target = "";
  private dirty = true;
  private presentationScope = 0;
  private readonly connection = new GatewayPageController(this, {
    getGateway: () => this.gateway,
    invalidateRequests: (change) =>
      this.reset(
        !change.sourceChanged && change.snapshot.phase !== "connected" && this.isConnected,
      ),
    onSnapshot: ({ initial }) => {
      if (initial) {
        this.reset();
      }
    },
    onPageActivation: () => {
      if (this.visible) {
        this.requestUpdate();
      }
    },
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (this.gateway === gateway && event.event === "cron") {
          this.dirty = true;
          this.requestUpdate();
        }
      }),
  );

  private get visible(): boolean {
    return this.isConnected && this.presented && this.ownerDocument.visibilityState !== "hidden";
  }

  private identity() {
    return resolveUiConversationIdentity(this.gateway?.snapshot ?? {}, this.sessionKey);
  }

  private reset(retain = false): void {
    // The inventory loader mutates its request state. Retire that whole state on
    // owner changes so a late page can never populate another session/connection.
    const cron = createInitialCronState<CronCompactJob>({
      client: this.gateway?.snapshot.client ?? null,
      connected: this.gateway?.snapshot.phase === "connected",
    });
    const identity = this.identity();
    cron.cronSessionFilter =
      identity.sessionKey && identity.agentId
        ? { sessionKey: identity.sessionKey, sessionAgentId: identity.agentId }
        : undefined;
    cron.cronJobsSortBy = "name";
    cron.canRefresh = () => this.cron === cron && this.visible && Boolean(cron.cronSessionFilter);
    const scope = this.gateway ? gatewayPresentationScope(this.gateway).key : 0;
    if (retain && scope !== 0 && scope === this.presentationScope) {
      // Only display facts survive transport loss; the old request owner is retired.
      cron.cronJobs = this.cron.cronJobs;
      cron.cronJobsSnapshotRevision = this.cron.cronJobsSnapshotRevision;
      cron.cronJobsTotal = this.cron.cronJobsTotal;
      cron.cronJobsHasMore = this.cron.cronJobsHasMore;
      cron.cronJobsNextOffset = this.cron.cronJobsNextOffset;
    }
    this.presentationScope = scope;
    this.cron = cron;
    this.showError = false;
    this.dirty = true;
  }

  override disconnectedCallback(): void {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const identity = this.identity();
    const target = JSON.stringify([identity.sessionKey, identity.agentId]);
    if (target !== this.target || changed.has("gateway")) {
      this.target = target;
      this.reset();
    }
    if (changed.has("presented") && this.presented) {
      this.dirty = true;
    }
    if (this.dirty) {
      void this.load();
    }
  }

  private async load(append = false, retry?: HTMLButtonElement): Promise<void> {
    const cron = this.cron;
    if (
      !this.visible ||
      !cron.connected ||
      !cron.cronSessionFilter ||
      cron.cronLoading ||
      cron.cronJobsLoadingMore
    ) {
      return;
    }
    this.dirty = false;
    const pending = loadCompactCronJobsPage(cron, { append });
    this.requestUpdate();
    await pending;
    if (this.cron !== cron || !this.isConnected) {
      return;
    }
    this.showError = cron.cronJobsError !== null;
    // Retry stays mounted/focusable during the request. Only move focus after
    // success if it still owns focus; background reads never take composer focus.
    const restoreFocus = retry && this.visible && this.ownerDocument.activeElement === retry;
    this.requestUpdate();
    await this.updateComplete;
    if (restoreFocus && !this.showError && this.cron === cron && this.visible) {
      this.querySelector<HTMLElement>(
        ".chat-summary__automation, .chat-summary__automation-message",
      )?.focus();
    }
  }

  private jobState(job: CronCompactJob): string {
    if (job.autoDisabled) {
      return t("chat.sessionDetails.automationAttention");
    }
    if (!job.enabled) {
      return t("chat.sessionDetails.automationPaused");
    }
    return this.connection.connected && job.runningAtMs !== undefined
      ? t("common.running")
      : job.schedule
        ? formatCronSchedule({ schedule: job.schedule })
        : t("chat.sessionDetails.automationEnabled");
  }

  private renderJob(job: CronCompactJob) {
    const title = job.name.trim() || job.id;
    const status = this.jobState(job);
    const search = `?${new URLSearchParams({ job: job.id })}`;
    const href = `${pathForRoute("cron", this.context?.basePath ?? "")}${search}`;
    return html`<a
      class="chat-summary__automation"
      href=${href}
      @click=${(event: MouseEvent) => {
        if (shouldHandleNavigationClick(event) && (this.onNavigate || this.context)) {
          event.preventDefault();
          if (this.onNavigate) {
            this.onNavigate(job.id);
          } else {
            this.context?.navigate("cron", { search });
          }
        }
      }}
    >
      <span class="chat-summary__automation-icon" aria-hidden="true">${icons.clock}</span>
      <openclaw-summary-overflow
        class="chat-summary__automation-title"
        .text=${title}
      ></openclaw-summary-overflow>
      <span class="chat-summary__automation-state" title=${status}>${status}</span>
    </a>`;
  }

  protected override render() {
    const cron = this.cron;
    const loading = cron.cronLoading || cron.cronJobsLoadingMore;
    const loaded = cron.cronJobsSnapshotRevision !== null;
    return html`<div class="chat-summary__automations" aria-busy=${loading}>
      ${!cron.connected && loaded ? html`<div class="chat-summary__automation-message" role="status">${t("chat.sessionDetails.automationOffline")}</div>` : nothing}
      ${repeat(
        cron.cronJobs,
        (job) => job.id,
        (job) => this.renderJob(job),
      )}
      ${
        this.showError
          ? html`<div class="chat-summary__automation-error">
              <span role="status">${t("chat.sessionDetails.automationError")}</span>
              <button
                type="button"
                class="chip chat-summary__automation-retry"
                aria-disabled=${loading || !cron.connected}
                @click=${(event: MouseEvent) => {
                  const button = event.currentTarget;
                  if (button instanceof HTMLButtonElement) {
                    void this.load(false, button);
                  }
                }}
              >
                ${t("common.retry")}
              </button>
            </div>`
          : !loaded || !cron.cronJobs.length
            ? html`<div class="chat-summary__automation-message" role="status" tabindex="-1">
                ${
                  !cron.cronSessionFilter
                    ? t("chat.sessionDetails.automationUnavailable")
                    : !cron.connected
                      ? t("chat.sessionDetails.automationOffline")
                      : !loaded
                        ? t("chat.sessionDetails.automationLoading")
                        : t("chat.sessionDetails.automationEmpty")
                }
              </div>`
            : nothing
      }
      ${
        cron.cronJobsHasMore && !this.showError
          ? html`<button
              type="button"
              class="chip chat-summary__automation-more"
              ?disabled=${loading || !cron.connected}
              @click=${() => void this.load(true)}
            >
              ${t("chat.sessionDetails.automationMore")}
            </button>`
          : nothing
      }
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-summary-automations")) {
  customElements.define("openclaw-chat-summary-automations", ChatSummaryAutomationsElement);
}
