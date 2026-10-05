import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  UsersLinkChannelIdentityResult,
  UsersListChannelIdentitiesResult,
  UsersUnlinkChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";

registerProfileEnglish();

type UserChannelIdentityLink = UsersListChannelIdentitiesResult["links"][number];
type UserChannelIdentity = UserChannelIdentityLink["identity"];
type ChannelIdentityMutation = {
  kind: "link" | "unlink";
  profileId: string;
  identity: UserChannelIdentity;
};

/** Shared synchronously by ProfilePage and this section to retire stale async results. */
export type ProfileChannelIdentityGenerations = {
  request: number;
  target: number;
};

export type ProfileChannelIdentityBusyState = Readonly<{
  loading: boolean;
  mutation: boolean;
}>;

function sameChannelIdentity(left: UserChannelIdentity, right: UserChannelIdentity): boolean {
  return (
    left.channelId === right.channelId &&
    left.accountId === right.accountId &&
    left.senderId === right.senderId
  );
}

function sameConnectionScopes(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const leftScopes = new Set(left);
  const rightScopes = new Set(right);
  return (
    leftScopes.size === rightScopes.size && [...leftScopes].every((scope) => rightScopes.has(scope))
  );
}

/** Channel account links are an operator-admin control on the existing Profile screen. */
export class ProfileChannelIdentities extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @property({ attribute: false }) profileId: string | null = null;
  @property({ attribute: false }) visible = false;
  @property({ attribute: false }) profileReady = false;
  @property({ attribute: false }) identityBusy = false;
  @property({ attribute: false }) identityGeneration = 0;
  @property({ attribute: false }) targetGeneration = 0;
  @property({ attribute: false }) generations: ProfileChannelIdentityGenerations | null = null;

  @state() private links: UserChannelIdentityLink[] | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private status: string | null = null;
  @state() private mutation: ChannelIdentityMutation | null = null;
  @state() private channelId = "";
  @state() private accountId = "";
  @state() private senderId = "";

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private canManage = false;
  private scopes: readonly string[] | null = null;
  private boundProfileId: string | null = null;
  private boundIdentityGeneration = 0;
  private boundTargetGeneration = 0;
  private boundSourceRequest = 0;
  private boundSourceTarget = 0;
  private boundProfileReady = false;
  private listRequestId = 0;
  private mutationId = 0;
  private unsubscribe: (() => void) | null = null;
  private lastReportedBusy: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = this.context.gateway.subscribe((snapshot) => this.applySnapshot(snapshot));
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listRequestId += 1;
    this.mutationId += 1;
    this.client = null;
    this.connected = false;
    this.canManage = false;
    this.scopes = null;
    this.links = null;
    this.loading = false;
    this.error = null;
    this.status = null;
    this.mutation = null;
    this.channelId = "";
    this.accountId = "";
    this.senderId = "";
    this.lastReportedBusy = null;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (
      changed.has("profileId") ||
      changed.has("visible") ||
      changed.has("profileReady") ||
      changed.has("identityBusy") ||
      changed.has("identityGeneration") ||
      changed.has("targetGeneration") ||
      changed.has("generations")
    ) {
      this.applySnapshot(this.context.gateway.snapshot);
    }
  }

  protected override updated() {
    const busyState = this.busyState;
    const key = `${busyState.loading}:${busyState.mutation}`;
    if (key === this.lastReportedBusy) {
      return;
    }
    this.lastReportedBusy = key;
    this.dispatchEvent(
      new CustomEvent<ProfileChannelIdentityBusyState>("profile-channel-identities-busy-changed", {
        detail: busyState,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private get busyState(): ProfileChannelIdentityBusyState {
    return { loading: this.loading, mutation: this.mutation !== null };
  }

  private get hasAdminGrant() {
    return this.connected && this.scopes?.includes("operator.admin") === true;
  }

  private get parentGenerationCurrent() {
    return (
      this.generations?.request === this.identityGeneration &&
      this.generations?.target === this.targetGeneration
    );
  }

  private get canManageChannelIdentities() {
    return (
      this.visible &&
      this.client !== null &&
      this.hasAdminGrant &&
      this.profileId !== null &&
      this.profileId !== GATEWAY_OWNER_PROFILE_ID
    );
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const nextConnected = snapshot.phase === "connected" && snapshot.client !== null;
    const nextClient = nextConnected ? snapshot.client : null;
    const nextScopes = nextConnected ? (snapshot.hello?.auth?.scopes ?? null) : null;
    const nextCanManage = nextConnected && nextScopes?.includes("operator.admin") === true;
    const sourceRequest = this.generations?.request ?? this.identityGeneration;
    const sourceTarget = this.generations?.target ?? this.targetGeneration;
    const targetChanged =
      nextClient !== this.client ||
      nextConnected !== this.connected ||
      this.profileId !== this.boundProfileId ||
      this.targetGeneration !== this.boundTargetGeneration ||
      sourceTarget !== this.boundSourceTarget;
    const requestChanged =
      this.identityGeneration !== this.boundIdentityGeneration ||
      sourceRequest !== this.boundSourceRequest;
    const grantChanged =
      nextCanManage !== this.canManage || !sameConnectionScopes(this.scopes, nextScopes);
    const profileReadyChanged = this.profileReady !== this.boundProfileReady;

    this.client = nextClient;
    this.connected = nextConnected;
    this.canManage = nextCanManage;
    this.scopes = nextScopes ? [...nextScopes] : nextScopes;

    if (!targetChanged && !requestChanged && !grantChanged && !profileReadyChanged) {
      return;
    }
    this.boundProfileId = this.profileId;
    this.boundIdentityGeneration = this.identityGeneration;
    this.boundTargetGeneration = this.targetGeneration;
    this.boundSourceRequest = sourceRequest;
    this.boundSourceTarget = sourceTarget;
    this.boundProfileReady = this.profileReady;
    this.listRequestId += 1;
    this.links = null;
    this.loading = false;
    this.error = null;
    this.status = null;

    if (targetChanged) {
      this.mutationId += 1;
      this.mutation = null;
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
    }

    if (this.canReadCurrentProfile() && !this.mutation) {
      void this.loadLinks();
    }
  }

  private canReadCurrentProfile() {
    return this.canManageChannelIdentities && this.profileReady && this.parentGenerationCurrent;
  }

  private isCurrentTarget(
    client: GatewayBrowserClient,
    profileId: string,
    identityGeneration: number,
    targetGeneration: number,
  ) {
    return (
      client === this.client &&
      this.canReadCurrentProfile() &&
      this.profileId === profileId &&
      this.identityGeneration === identityGeneration &&
      this.targetGeneration === targetGeneration
    );
  }

  private async loadLinks() {
    const client = this.client;
    const profileId = this.profileId;
    if (!client || !profileId || !this.canReadCurrentProfile() || this.mutation) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const requestId = ++this.listRequestId;
    this.loading = true;
    this.error = null;
    this.status = null;
    try {
      const result = await client.request<UsersListChannelIdentitiesResult>(
        "users.listChannelIdentities",
        { profileId },
      );
      if (
        requestId !== this.listRequestId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      this.links = result.links.filter((link) => link.profileId === profileId);
    } catch (error) {
      if (
        requestId === this.listRequestId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.loadFailed"));
      }
    } finally {
      if (
        requestId === this.listRequestId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.loading = false;
      }
    }
  }

  private async linkIdentity() {
    const client = this.client;
    const profileId = this.profileId;
    const identity: UserChannelIdentity = {
      channelId: this.channelId,
      accountId: this.accountId,
      senderId: this.senderId,
    };
    if (
      !client ||
      !profileId ||
      !this.canReadCurrentProfile() ||
      this.identityBusy ||
      this.loading ||
      this.links === null ||
      this.mutation ||
      !identity.channelId.trim() ||
      !identity.accountId.trim() ||
      !identity.senderId.trim()
    ) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const mutationId = ++this.mutationId;
    this.listRequestId += 1;
    this.mutation = { kind: "link", profileId, identity };
    this.error = null;
    this.status = null;
    try {
      const result = await client.request<UsersLinkChannelIdentityResult>(
        "users.linkChannelIdentity",
        { profileId, identity },
      );
      if (
        mutationId !== this.mutationId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      if (result.profileId !== profileId || !sameChannelIdentity(result.identity, identity)) {
        throw new Error(t("profilePage.channelIdentities.linkFailed"));
      }
      const links = this.links ?? [];
      if (!links.some((link) => sameChannelIdentity(link.identity, identity))) {
        this.links = [...links, result];
      }
      this.channelId = "";
      this.accountId = "";
      this.senderId = "";
      this.status = t("profilePage.channelIdentities.linked");
    } catch (error) {
      if (
        mutationId === this.mutationId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.linkFailed"));
      }
    } finally {
      if (mutationId === this.mutationId && client === this.client) {
        this.mutation = null;
        if (
          !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration) &&
          this.canReadCurrentProfile()
        ) {
          void this.loadLinks();
        }
      }
    }
  }

  private async unlinkIdentity(link: UserChannelIdentityLink) {
    const client = this.client;
    const profileId = this.profileId;
    if (
      !client ||
      !profileId ||
      link.profileId !== profileId ||
      !this.canReadCurrentProfile() ||
      this.identityBusy ||
      this.loading ||
      this.mutation
    ) {
      return;
    }
    const identityGeneration = this.identityGeneration;
    const targetGeneration = this.targetGeneration;
    const mutationId = ++this.mutationId;
    this.listRequestId += 1;
    this.mutation = { kind: "unlink", profileId, identity: link.identity };
    this.error = null;
    this.status = null;
    try {
      await client.request<UsersUnlinkChannelIdentityResult>("users.unlinkChannelIdentity", {
        profileId,
        identity: link.identity,
      });
      if (
        mutationId !== this.mutationId ||
        !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        return;
      }
      this.links = (this.links ?? []).filter(
        (candidate) => !sameChannelIdentity(candidate.identity, link.identity),
      );
      this.status = t("profilePage.channelIdentities.unlinked");
    } catch (error) {
      if (
        mutationId === this.mutationId &&
        this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration)
      ) {
        this.error = formatUiError(error, t("profilePage.channelIdentities.unlinkFailed"));
      }
    } finally {
      if (mutationId === this.mutationId && client === this.client) {
        this.mutation = null;
        if (
          !this.isCurrentTarget(client, profileId, identityGeneration, targetGeneration) &&
          this.canReadCurrentProfile()
        ) {
          void this.loadLinks();
        }
      }
    }
  }

  private renderLinks(busy: boolean) {
    if (this.links === null) {
      return nothing;
    }
    if (this.links.length === 0) {
      return renderSettingsEmpty(t("profilePage.channelIdentities.empty"));
    }
    return this.links.map((link) =>
      renderSettingsRow({
        title: html`<code>${link.identity.channelId}</code>`,
        description: html`
          ${t("profilePage.channelIdentities.accountId")}:
          <code>${link.identity.accountId}</code> · ${t("profilePage.channelIdentities.senderId")}:
          <code>${link.identity.senderId}</code>
        `,
        stackedOnNarrow: true,
        control: html`<button
          type="button"
          class="btn"
          aria-label=${`${t("profilePage.channelIdentities.remove")} ${link.identity.channelId}, ${link.identity.accountId}, ${link.identity.senderId}`}
          ?disabled=${busy}
          @click=${() => void this.unlinkIdentity(link)}
        >
          ${
            this.mutation?.kind === "unlink" &&
            sameChannelIdentity(this.mutation.identity, link.identity)
              ? t("profilePage.channelIdentities.removing")
              : t("profilePage.channelIdentities.remove")
          }
        </button>`,
      }),
    );
  }

  override render() {
    if (!this.canManageChannelIdentities) {
      return nothing;
    }
    const busy = this.loading || this.mutation !== null || this.identityBusy;
    const formDisabled = busy || this.links === null;
    return html`<form
      id="settings-profile-channel-identities"
      aria-busy=${busy}
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void this.linkIdentity();
      }}
    >
      ${renderSettingsSection(
        {
          title: t("profilePage.channelIdentities.title"),
          description: t("profilePage.channelIdentities.description"),
        },
        html`
          ${
            this.loading && this.links === null
              ? renderSettingsLoadingSkeleton({
                  label: t("profilePage.channelIdentities.loading"),
                  rows: 1,
                })
              : nothing
          }
          ${
            this.error
              ? renderSettingsRow({
                  title: t("profilePage.channelIdentities.errorTitle"),
                  description: this.error,
                  role: "alert",
                  stackedOnNarrow: true,
                  control:
                    this.links === null
                      ? html`<button
                          type="button"
                          class="btn"
                          aria-label=${t("profilePage.channelIdentities.retry")}
                          ?disabled=${this.loading || this.mutation !== null}
                          @click=${() => void this.loadLinks()}
                        >
                          ${t("profilePage.channelIdentities.retry")}
                        </button>`
                      : nothing,
                })
              : nothing
          }
          ${this.status ? renderSettingsRow({ title: this.status, role: "status" }) : nothing}
          ${this.renderLinks(busy)}
          ${(
            [
              ["channelId", "channelId"],
              ["accountId", "accountId"],
              ["senderId", "senderId"],
            ] as const
          ).map(([field, label]) =>
            renderSettingsRow({
              title: t(`profilePage.channelIdentities.${label}`),
              stacked: true,
              control: html`<input
                class="settings-input"
                type="text"
                aria-label=${t(`profilePage.channelIdentities.${label}`)}
                autocomplete="off"
                maxlength="512"
                pattern="\\S(?:.*\\S)?"
                required
                .value=${this[field]}
                ?disabled=${formDisabled}
                @input=${(event: Event) => {
                  // SAFETY: This listener is attached directly to the rendered input; currentTarget is that input during dispatch.
                  this[field] = (event.currentTarget as HTMLInputElement).value;
                }}
              />`,
            }),
          )}
          ${renderSettingsRow({
            title: t("profilePage.channelIdentities.addTitle"),
            stackedOnNarrow: true,
            control: html`<button type="submit" class="btn" ?disabled=${formDisabled}>
              ${
                this.mutation?.kind === "link"
                  ? t("profilePage.channelIdentities.linking")
                  : t("profilePage.channelIdentities.add")
              }
            </button>`,
          })}
        `,
      )}
    </form>`;
  }
}

if (!customElements.get("openclaw-profile-channel-identities")) {
  customElements.define("openclaw-profile-channel-identities", ProfileChannelIdentities);
}
