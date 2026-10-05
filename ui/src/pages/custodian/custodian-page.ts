import { consume } from "@lit/context";
import type {
  SystemChangeEntry,
  SystemChangesListResult,
  UserProfile,
  UsersSetDisplayNameResult,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import "../../components/openclaw-mascot.ts";
import { t } from "../../i18n/index.ts";
import { channelSnapshotHasActiveChannel } from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "../../styles/custodian.css";
import { renderCustodianChangeHistory } from "./custodian-history.ts";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-surface.ts";

const SYSTEM_CHANGE_PAGE_SIZE = 50;

type OnboardingIdentityOwner = {
  client: GatewayBrowserClient;
  connectionRevision: number;
  gatewayUrl: string;
  recoveryScope: string | null;
  selfUserId: string | null;
  selfUserProfileId: string | null;
};

export class CustodianPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) newAgentIntent = false;
  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;

  @state() private historyAvailable = false;
  @state() private historyOpen = false;
  @state() private historyEntries: SystemChangeEntry[] = [];
  @state() private historyNextCursor: string | null = null;
  @state() private historyLoading = false;
  @state() private historyLoadingMore = false;
  @state() private historyError: string | null = null;
  @state() private onboardingNameProfile: UserProfile | null = null;
  @state() private onboardingNameDraft = "";
  @state() private onboardingNameLoading = false;
  @state() private onboardingNameBusy = false;
  @state() private onboardingNameError: string | null = null;

  private historyLoaded = false;
  private historyClient: GatewayBrowserClient | null = null;
  private historyRequestEpoch = 0;
  private channelsSource: ApplicationContext["channels"] | null = null;
  private onboardingOwner: OnboardingIdentityOwner | null = null;
  private onboardingNameRequestEpoch = 0;
  private onboardingNameSkipped = false;
  private stopGatewaySubscription: (() => void) | null = null;

  constructor() {
    super();
    void new SubscriptionsController(this)
      .watch(
        () => this.store,
        (store, notify) => {
          const cleanup = store.subscribe(notify);
          void store.refreshTranscriptIfIdle();
          return cleanup;
        },
      )
      .effect(
        () => this.context?.channels,
        (channels) => {
          this.channelsSource = channels;
          const stop = channels.subscribe(() => {
            this.ensureOnboardingChannelStatus();
            this.requestUpdate();
          });
          this.ensureOnboardingChannelStatus();
          return () => {
            stop();
            if (this.channelsSource === channels) {
              this.channelsSource = null;
            }
          };
        },
      );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stopGatewaySubscription ??= this.context.gateway.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = null;
    this.onboardingNameRequestEpoch += 1;
    this.onboardingOwner = null;
    this.onboardingNameProfile = null;
    this.onboardingNameDraft = "";
    this.onboardingNameLoading = false;
    this.onboardingNameBusy = false;
    this.onboardingNameError = null;
    this.onboardingNameSkipped = false;
    super.disconnectedCallback();
  }

  protected override async getUpdateComplete(): Promise<boolean> {
    const complete = await super.getUpdateComplete();
    const surface = this.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-surface",
    );
    await surface?.updateComplete;
    return complete;
  }

  override willUpdate(): void {
    this.synchronizeHistoryClient();
    this.ensureOnboardingChannelStatus();
    this.synchronizeOnboardingIdentity();
  }

  private ensureOnboardingChannelStatus(): void {
    const channels = this.channelsSource;
    if (!this.onboarding || this.store.channelOnboardingNudgeClosed || !channels) {
      return;
    }
    const channelState = channels.state;
    if (
      !channelState.connected ||
      channelState.channelsSnapshot ||
      channelState.channelsLoading ||
      channelState.channelsError
    ) {
      return;
    }
    void channels.refresh(false);
  }

  private synchronizeHistoryClient(): void {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const available =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.changes.list") === true;
    if (client !== this.historyClient || available !== this.historyAvailable) {
      this.historyClient = client;
      this.historyAvailable = available;
      this.historyOpen = false;
      this.resetHistory();
    }
  }

  private currentOnboardingOwner(): OnboardingIdentityOwner | null {
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    if (!this.onboarding || !client || !hasOperatorWriteAccess(snapshot.hello?.auth ?? null)) {
      return null;
    }
    return {
      client,
      connectionRevision: gateway.connectionRevision,
      gatewayUrl: gateway.connection.gatewayUrl,
      recoveryScope: client.recoveryScope ?? null,
      selfUserId: snapshot.selfUser?.id ?? null,
      selfUserProfileId: snapshot.selfUser?.identity?.id ?? null,
    };
  }

  private sameOnboardingOwner(
    left: OnboardingIdentityOwner | null,
    right: OnboardingIdentityOwner | null,
  ): boolean {
    return (
      left === right ||
      (left !== null &&
        right !== null &&
        left.client === right.client &&
        left.connectionRevision === right.connectionRevision &&
        left.gatewayUrl === right.gatewayUrl &&
        left.recoveryScope === right.recoveryScope &&
        left.selfUserId === right.selfUserId &&
        left.selfUserProfileId === right.selfUserProfileId)
    );
  }

  private isCurrentOnboardingOwner(owner: OnboardingIdentityOwner): boolean {
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    return (
      this.onboarding &&
      this.onboardingOwner === owner &&
      snapshot.phase === "connected" &&
      snapshot.client === owner.client &&
      gateway.connectionRevision === owner.connectionRevision &&
      gateway.connection.gatewayUrl === owner.gatewayUrl &&
      (owner.client.recoveryScope ?? null) === owner.recoveryScope &&
      (snapshot.selfUser?.id ?? null) === owner.selfUserId &&
      (snapshot.selfUser?.identity?.id ?? null) === owner.selfUserProfileId &&
      hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
    );
  }

  private synchronizeOnboardingIdentity(): void {
    const nextOwner = this.currentOnboardingOwner();
    if (this.sameOnboardingOwner(this.onboardingOwner, nextOwner)) {
      return;
    }
    this.onboardingOwner = nextOwner;
    this.onboardingNameRequestEpoch += 1;
    this.onboardingNameProfile = null;
    this.onboardingNameDraft = "";
    this.onboardingNameLoading = false;
    this.onboardingNameBusy = false;
    this.onboardingNameError = null;
    if (nextOwner) {
      void this.loadOnboardingProfile(nextOwner);
    }
  }

  private async loadOnboardingProfile(owner: OnboardingIdentityOwner): Promise<void> {
    if (!this.isCurrentOnboardingOwner(owner) || this.onboardingNameLoading) {
      return;
    }
    const requestEpoch = ++this.onboardingNameRequestEpoch;
    const isCurrent = () =>
      this.isCurrentOnboardingOwner(owner) && requestEpoch === this.onboardingNameRequestEpoch;
    this.onboardingNameLoading = true;
    this.onboardingNameError = null;
    try {
      const profile = await this.context.gateway.loadSelfProfile();
      if (!isCurrent()) {
        return;
      }
      this.onboardingNameProfile = profile;
      this.onboardingNameDraft = profile?.displayName ?? "";
    } catch (error) {
      if (isCurrent()) {
        this.onboardingNameError = formatUiError(error, t("custodian.onboardingName.loadFailed"));
      }
    } finally {
      if (isCurrent()) {
        this.onboardingNameLoading = false;
      }
    }
  }

  private async saveOnboardingName(): Promise<void> {
    const owner = this.onboardingOwner;
    const profile = this.onboardingNameProfile;
    const name = this.onboardingNameDraft.trim();
    if (
      !owner ||
      !profile ||
      !name ||
      this.onboardingNameBusy ||
      !this.isCurrentOnboardingOwner(owner)
    ) {
      return;
    }
    const selfUserAtSaveStart = this.context.gateway.snapshot.selfUser;
    const requestEpoch = this.onboardingNameRequestEpoch;
    const isCurrentRequest = () =>
      this.isCurrentOnboardingOwner(owner) && this.onboardingNameRequestEpoch === requestEpoch;
    const isCurrent = () => isCurrentRequest() && this.onboardingNameProfile === profile;
    this.onboardingNameBusy = true;
    this.onboardingNameError = null;
    try {
      const result = await owner.client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
        profileId: profile.id,
        displayName: name,
        onlyIfUnset: true,
      });
      if (!isCurrent()) {
        return;
      }
      const currentSelfUser = this.context.gateway.snapshot.selfUser;
      const hasNewerDisplayName =
        currentSelfUser?.id === profile.id && currentSelfUser.name !== selfUserAtSaveStart?.name;
      const savedProfile = hasNewerDisplayName
        ? { ...result.profile, displayName: currentSelfUser.name ?? null }
        : result.profile;
      this.onboardingNameProfile = savedProfile;
      this.onboardingNameDraft = savedProfile.displayName ?? "";
      if (!hasNewerDisplayName) {
        this.context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
      }
    } catch (error) {
      if (isCurrent()) {
        this.onboardingNameError = formatUiError(error, t("custodian.onboardingName.saveFailed"));
      }
    } finally {
      if (isCurrentRequest()) {
        this.onboardingNameBusy = false;
      }
    }
  }

  private shouldRenderOnboardingNamePrompt(): boolean {
    const owner = this.onboardingOwner;
    if (!owner || !this.isCurrentOnboardingOwner(owner) || this.onboardingNameSkipped) {
      return false;
    }
    const profile = this.onboardingNameProfile;
    return profile ? !profile.displayName?.trim() : this.onboardingNameError !== null;
  }

  private renderOnboardingNamePrompt() {
    const owner = this.onboardingOwner;
    if (!owner || !this.shouldRenderOnboardingNamePrompt()) {
      return nothing;
    }
    const profile = this.onboardingNameProfile;
    if (!profile) {
      const error = this.onboardingNameError;
      if (!error) {
        return nothing;
      }
      return html`<section class="custodian__name-prompt custodian__column">
        <p class="custodian__error" role="alert">
          <span>${error}</span>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.onboardingNameLoading}
            @click=${() => void this.loadOnboardingProfile(owner)}
          >
            ${this.onboardingNameLoading ? t("common.loading") : t("common.retry")}
          </button>
        </p>
      </section>`;
    }
    if (profile.displayName?.trim()) {
      return nothing;
    }
    return html`<section
      class="custodian__name-prompt custodian__column"
      aria-labelledby="custodian-name-title"
    >
      <div>
        <h2 id="custodian-name-title">${t("custodian.onboardingName.title")}</h2>
        <p id="custodian-name-description">${t("custodian.onboardingName.description")}</p>
      </div>
      <form
        class="custodian__name-form"
        aria-busy=${this.onboardingNameBusy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.saveOnboardingName();
        }}
      >
        <label for="custodian-onboarding-display-name"
          >${t("custodian.onboardingName.label")}</label
        >
        <input
          id="custodian-onboarding-display-name"
          class="settings-input"
          type="text"
          maxlength="256"
          autocomplete="nickname"
          aria-describedby="custodian-name-description${this.onboardingNameError ? " custodian-name-error" : ""}"
          .value=${this.onboardingNameDraft}
          ?disabled=${this.onboardingNameBusy}
          @input=${(event: Event) => {
            const input = event.currentTarget;
            if (input instanceof HTMLInputElement) {
              this.onboardingNameDraft = input.value;
              this.onboardingNameError = null;
            }
          }}
        />
        ${
          this.onboardingNameError
            ? html`<p id="custodian-name-error" class="custodian__name-error" role="alert">
                ${this.onboardingNameError}
              </p>`
            : nothing
        }
        <div class="custodian__name-actions">
          <button
            class="btn btn--ghost"
            type="button"
            ?disabled=${this.onboardingNameBusy}
            @click=${() => {
              this.onboardingNameSkipped = true;
              this.requestUpdate();
            }}
          >
            ${t("custodian.onboardingName.skip")}
          </button>
          <button
            class="btn"
            type="submit"
            ?disabled=${this.onboardingNameBusy || !this.onboardingNameDraft.trim()}
          >
            ${this.onboardingNameBusy ? t("common.saving") : t("custodian.onboardingName.save")}
          </button>
        </div>
      </form>
    </section>`;
  }

  private resetHistory(): void {
    this.historyRequestEpoch += 1;
    this.historyEntries = [];
    this.historyNextCursor = null;
    this.historyLoading = false;
    this.historyLoadingMore = false;
    this.historyError = null;
    this.historyLoaded = false;
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    if (this.historyOpen && !this.historyLoading && !this.historyLoadingMore) {
      void this.loadHistory(true);
    }
  }

  private async loadHistory(reset: boolean): Promise<void> {
    const client = this.historyClient;
    const cursor = reset ? undefined : (this.historyNextCursor ?? undefined);
    if (
      !client ||
      !this.historyAvailable ||
      this.historyLoading ||
      this.historyLoadingMore ||
      (!reset && !cursor)
    ) {
      return;
    }
    const epoch = ++this.historyRequestEpoch;
    if (reset) {
      this.historyLoading = true;
    } else {
      this.historyLoadingMore = true;
    }
    this.historyError = null;
    const isCurrent = () =>
      this.isConnected &&
      this.historyClient === client &&
      this.historyRequestEpoch === epoch &&
      this.historyAvailable;
    try {
      const result = await client.request<SystemChangesListResult>("openclaw.changes.list", {
        limit: SYSTEM_CHANGE_PAGE_SIZE,
        ...(cursor ? { beforeCursor: cursor } : {}),
      });
      if (!isCurrent()) {
        return;
      }
      this.historyEntries = reset ? result.entries : [...this.historyEntries, ...result.entries];
      this.historyNextCursor = result.nextCursor ?? null;
      this.historyLoaded = true;
    } catch {
      if (isCurrent()) {
        this.historyError = t("custodian.history.requestFailed");
        this.historyLoaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.historyLoading = false;
        this.historyLoadingMore = false;
      }
    }
  }

  override render() {
    const channelState = this.channelsSource?.state;
    const channelSnapshot = channelState?.channelsSnapshot ?? null;
    const channelStatusError =
      this.onboarding && !this.store.channelOnboardingNudgeClosed && channelState?.connected
        ? (channelState?.channelsError ?? null)
        : null;
    const showChannelOnboardingNudge =
      this.onboarding &&
      !this.store.channelOnboardingNudgeClosed &&
      channelState?.connected &&
      !channelState.channelsLoading &&
      channelStatusError === null &&
      channelSnapshot !== null &&
      channelSnapshot.partial !== true &&
      !channelSnapshotHasActiveChannel(channelSnapshot);
    const historyContent =
      this.historyOpen && this.historyAvailable
        ? renderCustodianChangeHistory({
            entries: this.historyEntries,
            error: this.historyError,
            loaded: this.historyLoaded,
            loading: this.historyLoading,
            loadingMore: this.historyLoadingMore,
            nextCursor: this.historyNextCursor,
            onLoad: (reset) => void this.loadHistory(reset),
          })
        : nothing;
    return html`
      <section
        class="custodian custodian--page ${
          this.store.setupRequired ? "custodian--setup-required" : ""
        } ${this.shouldRenderOnboardingNamePrompt() ? "custodian--onboarding" : ""}"
      >
        <header
          class="custodian__header custodian__column ${
            this.onboarding ? "custodian__header--minimal" : ""
          }"
        >
          ${
            this.onboarding
              ? nothing
              : html`<div class="custodian__identity">
                  <div class="custodian__mark" aria-hidden="true">
                    <openclaw-mascot
                      .mood=${this.store.sending ? "thinking" : "idle"}
                      .size=${38}
                    ></openclaw-mascot>
                  </div>
                  <div>
                    <h1>${t("custodian.title")}</h1>
                    <p>${t("custodian.subtitleCaretaker")}</p>
                  </div>
                </div>`
          }
          <div class="custodian__header-actions">
            ${
              this.onboarding
                ? html`<openclaw-sidebar-attention></openclaw-sidebar-attention>`
                : nothing
            }
            ${
              this.historyAvailable
                ? html`<button
                    class="btn btn--ghost custodian__history-toggle"
                    type="button"
                    aria-expanded=${this.historyOpen ? "true" : "false"}
                    @click=${() => this.toggleHistory()}
                  >
                    ${t("custodian.history.button")}
                  </button>`
                : nothing
            }
            ${
              this.onboarding
                ? html`<button
                    class="btn btn--ghost"
                    type="button"
                    @click=${() => this.store.exitSetup()}
                  >
                    ${t("custodian.exitSetup")}
                  </button>`
                : nothing
            }
          </div>
        </header>

        ${this.renderOnboardingNamePrompt()}

        <openclaw-custodian-surface
          class="custodian__column"
          .store=${this.store}
          .onboarding=${this.onboarding}
          .newAgentIntent=${this.newAgentIntent}
          .showChannelOnboardingNudge=${showChannelOnboardingNudge}
          .channelOnboardingError=${channelStatusError}
          .channelOnboardingRetrying=${channelState?.channelsLoading ?? false}
          .onRetryChannelOnboarding=${() => void this.channelsSource?.refresh(false)}
          .historyContent=${historyContent}
        ></openclaw-custodian-surface>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-custodian-page")) {
  customElements.define("openclaw-custodian-page", CustodianPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": CustodianPage;
  }
}
