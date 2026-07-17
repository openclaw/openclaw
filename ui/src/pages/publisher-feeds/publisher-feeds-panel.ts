import { consume } from "@lit/context";
import type {
  PublisherFeedFollow,
  PublisherFeedRefreshStatus,
  PublisherFeedsFollowResult,
  PublisherFeedsListResult,
  PublisherFeedsRefreshResult,
  PublisherFeedsUnfollowResult,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/publisher-feeds.css";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return t("common.never");
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function refreshLabel(status: PublisherFeedRefreshStatus): string {
  if (status.stopped) {
    return t("publisherFeedsPage.stopped");
  }
  return status.running ? t("common.refreshing") : t("publisherFeedsPage.scheduled");
}

class PublisherFeedsPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private client: GatewayBrowserClient | null = null;
  @state() private connected = false;
  @state() private loading = false;
  @state() private follows: PublisherFeedFollow[] = [];
  @state() private refreshStatus: PublisherFeedRefreshStatus | null = null;
  @state() private error: string | null = null;
  @state() private publisherId = "";
  @state() private feedProfile = "";
  @state() private operation: "follow" | "refresh" | string | null = null;
  @state() private canFollow = false;
  @state() private canUnfollow = false;
  @state() private canRefresh = false;

  private sourceGeneration = 0;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.applyGatewaySnapshot(gateway.snapshot, true);
      return gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot, false));
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.sourceGeneration += 1;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, sourceChanged: boolean) {
    const connectionChanged = snapshot.connected !== this.connected;
    const clientChanged = snapshot.client !== this.client;
    this.client = snapshot.client;
    this.connected = snapshot.connected;
    const canWrite = hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    this.canFollow =
      canWrite && isGatewayMethodAdvertised(snapshot, "publisherFeeds.follow") === true;
    this.canUnfollow =
      canWrite && isGatewayMethodAdvertised(snapshot, "publisherFeeds.unfollow") === true;
    this.canRefresh =
      canWrite && isGatewayMethodAdvertised(snapshot, "publisherFeeds.refresh") === true;
    if (sourceChanged || connectionChanged || clientChanged) {
      this.sourceGeneration += 1;
      this.loading = false;
      this.operation = null;
      this.error = null;
      if (sourceChanged || clientChanged) {
        this.follows = [];
        this.refreshStatus = null;
      }
    }
    if (
      snapshot.connected &&
      snapshot.client &&
      (sourceChanged || connectionChanged || clientChanged)
    ) {
      void this.load();
    }
  }

  private async load() {
    const client = this.client;
    if (!client || !this.connected || this.loading) {
      return;
    }
    const generation = this.sourceGeneration;
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<PublisherFeedsListResult>("publisherFeeds.list", {});
      if (generation !== this.sourceGeneration || client !== this.client) {
        return;
      }
      this.follows = result.follows;
      this.refreshStatus = result.refresh;
    } catch (error) {
      if (generation === this.sourceGeneration && client === this.client) {
        this.error = errorMessage(error);
      }
    } finally {
      if (generation === this.sourceGeneration && client === this.client) {
        this.loading = false;
      }
    }
  }

  private async follow() {
    const client = this.client;
    const publisherId = this.publisherId.trim();
    const feedProfile = this.feedProfile.trim();
    if (
      !client ||
      !this.connected ||
      !this.canFollow ||
      this.loading ||
      !publisherId ||
      !feedProfile
    ) {
      return;
    }
    const generation = this.sourceGeneration;
    this.operation = "follow";
    this.error = null;
    try {
      await client.request<PublisherFeedsFollowResult>("publisherFeeds.follow", {
        publisherId,
        feedProfile,
      });
      if (generation !== this.sourceGeneration || client !== this.client) {
        return;
      }
      this.publisherId = "";
      this.operation = null;
      await this.load();
    } catch (error) {
      if (generation === this.sourceGeneration && client === this.client) {
        this.error = errorMessage(error);
      }
    } finally {
      if (
        generation === this.sourceGeneration &&
        client === this.client &&
        this.operation === "follow"
      ) {
        this.operation = null;
      }
    }
  }

  private async unfollow(follow: PublisherFeedFollow) {
    const client = this.client;
    const key = `${follow.sourceOrigin}\u0000${follow.publisherId}`;
    if (!client || !this.connected || !this.canUnfollow || this.operation) {
      return;
    }
    const generation = this.sourceGeneration;
    this.operation = key;
    this.error = null;
    try {
      await client.request<PublisherFeedsUnfollowResult>("publisherFeeds.unfollow", {
        publisherId: follow.publisherId,
        feedProfile: follow.feedProfile,
      });
      if (generation !== this.sourceGeneration || client !== this.client) {
        return;
      }
      this.follows = this.follows.filter(
        (candidate) =>
          candidate.sourceOrigin !== follow.sourceOrigin ||
          candidate.publisherId !== follow.publisherId,
      );
    } catch (error) {
      if (generation === this.sourceGeneration && client === this.client) {
        this.error = errorMessage(error);
      }
    } finally {
      if (
        generation === this.sourceGeneration &&
        client === this.client &&
        this.operation === key
      ) {
        this.operation = null;
      }
    }
  }

  private async refresh() {
    const client = this.client;
    if (!client || !this.connected || !this.canRefresh || this.loading || this.operation) {
      return;
    }
    const generation = this.sourceGeneration;
    this.operation = "refresh";
    this.error = null;
    try {
      const result = await client.request<PublisherFeedsRefreshResult>(
        "publisherFeeds.refresh",
        {},
      );
      if (generation !== this.sourceGeneration || client !== this.client) {
        return;
      }
      this.refreshStatus = result.status;
      this.operation = null;
      await this.load();
    } catch (error) {
      if (generation === this.sourceGeneration && client === this.client) {
        this.error = errorMessage(error);
      }
    } finally {
      if (
        generation === this.sourceGeneration &&
        client === this.client &&
        this.operation === "refresh"
      ) {
        this.operation = null;
      }
    }
  }

  override render() {
    const status = this.refreshStatus;
    const writesBusy = this.operation !== null || this.loading;
    const followDisabled =
      writesBusy ||
      !this.connected ||
      !this.canFollow ||
      !this.publisherId.trim() ||
      !this.feedProfile.trim();
    return renderSettingsPage(html`
      <form
        class="publisher-feeds-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.follow();
        }}
      >
        <input
          class="settings-input"
          name="publisher-id"
          autocomplete="off"
          aria-label=${t("publisherFeedsPage.publisherId")}
          placeholder=${t("publisherFeedsPage.publisherId")}
          .value=${this.publisherId}
          @input=${(event: Event) =>
            (this.publisherId = (event.currentTarget as HTMLInputElement).value)}
        />
        <input
          class="settings-input"
          name="feed-profile"
          autocomplete="off"
          aria-label=${t("publisherFeedsPage.feedProfile")}
          placeholder=${t("publisherFeedsPage.feedProfile")}
          .value=${this.feedProfile}
          @input=${(event: Event) =>
            (this.feedProfile = (event.currentTarget as HTMLInputElement).value)}
        />
        <button type="submit" class="btn btn--sm" ?disabled=${followDisabled}>
          ${this.operation === "follow"
            ? t("publisherFeedsPage.following")
            : t("publisherFeedsPage.follow")}
        </button>
      </form>

      ${this.error
        ? html`<div class="publisher-feeds-error" role="alert">
            <span>${this.error}</span>
            <button type="button" class="btn btn--sm" @click=${() => void this.load()}>
              ${t("common.retry")}
            </button>
          </div>`
        : nothing}
      ${renderSettingsSection(
        {
          title: t("publisherFeedsPage.refreshStatus"),
          actions: html`<button
            type="button"
            class="btn btn--sm btn--icon"
            aria-label=${t("publisherFeedsPage.refreshNow")}
            title=${t("publisherFeedsPage.refreshNow")}
            ?disabled=${writesBusy || !this.connected || !this.canRefresh}
            @click=${() => void this.refresh()}
          >
            ${icons.refresh}
          </button>`,
        },
        status
          ? html`
              ${renderSettingsRow({
                title: t("publisherFeedsPage.scheduler"),
                description: t("publisherFeedsPage.lastCompleted", {
                  timestamp: formatTimestamp(status.lastCompletedAt),
                }),
                control: renderSettingsStatus({
                  kind: status.stopped ? "muted" : status.lastFailedCount > 0 ? "warn" : "ok",
                  label: refreshLabel(status),
                }),
              })}
              ${renderSettingsRow({
                title: t("publisherFeedsPage.lastRun"),
                description: t("publisherFeedsPage.lastRunCounts", {
                  refreshed: String(status.lastRefreshedCount),
                  followed: String(status.lastFollowCount),
                  failed: String(status.lastFailedCount),
                }),
              })}
            `
          : renderSettingsEmpty(
              this.loading ? t("common.loading") : t("publisherFeedsPage.noStatus"),
            ),
      )}
      ${renderSettingsSection(
        { title: t("publisherFeedsPage.followed"), count: this.follows.length },
        this.follows.length > 0
          ? repeat(
              this.follows,
              (follow) => `${follow.sourceOrigin}\u0000${follow.publisherId}`,
              (follow) => {
                return renderSettingsRow({
                  title: follow.displayName || follow.publisherId,
                  description: html`${follow.publisherId} · ${follow.feedProfile} ·
                  ${follow.sourceOrigin}`,
                  control: html`
                    <span class="publisher-feeds-sequence">
                      ${follow.acceptedSequence === null
                        ? t("publisherFeedsPage.notRefreshed")
                        : t("publisherFeedsPage.sequence", {
                            sequence: String(follow.acceptedSequence),
                          })}
                      ·
                      ${t("publisherFeedsPage.verified", {
                        timestamp: formatTimestamp(follow.verifiedAt),
                      })}
                    </span>
                    <button
                      type="button"
                      class="btn btn--sm btn--icon"
                      aria-label=${t("publisherFeedsPage.unfollowNamed", {
                        name: follow.displayName || follow.publisherId,
                      })}
                      title=${t("publisherFeedsPage.unfollowNamed", {
                        name: follow.displayName || follow.publisherId,
                      })}
                      ?disabled=${writesBusy || !this.connected || !this.canUnfollow}
                      @click=${() => void this.unfollow(follow)}
                    >
                      ${icons.trash}
                    </button>
                  `,
                });
              },
            )
          : renderSettingsEmpty(
              this.loading ? t("common.loading") : t("publisherFeedsPage.noneFollowed"),
            ),
      )}
    `);
  }
}

if (!customElements.get("openclaw-publisher-feeds-panel")) {
  customElements.define("openclaw-publisher-feeds-panel", PublisherFeedsPanel);
}
