import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UserProfile,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { invalidateUserPreferences, saveUserPreferences } from "../../app/user-prefs-cache.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser } from "../../app/user-profile.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import "../../styles/profile.css";
import "../../features/github-connections/github-connections.ts";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import "./model-accounts.ts";
import "./personal-instructions.ts";
import "./profile-channel-identities.ts";
import { renderIdentitySection } from "./identity-section.ts";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import type { ProfileChannelIdentityBusyState } from "./profile-channel-identities.ts";
import { renderProfileHero } from "./profile-hero.ts";

registerModelAccountsEnglish();
registerProfileEnglish();

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

type IdentityChange =
  | { kind: "display-name" }
  | { kind: "avatar"; file: File }
  | { kind: "git-coauthor"; enabled: boolean };

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

export class ProfilePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private selfUser: AuthenticatedUser | null = null;
  @state() private ownProfile: UserProfile | null = null;
  @state() private displayName = "";
  @state() private gitCoauthorEnabled = true;
  @state() private identityLoading = false;
  @state() private identityBusy: IdentityChange["kind"] | null = null;
  @state() private identityError: string | null = null;
  @state() private identityProfileReady = false;
  @state() private channelIdentityBusy: ProfileChannelIdentityBusyState = {
    loading: false,
    mutation: false,
  };

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private connecting = false;
  private canWrite = false;
  private connectionScopes: readonly string[] | null = null;
  private readonly heroAvatarLoader = new IdentityAvatarController(this);
  private identityRequestId = 0;
  private channelIdentityProfileId: string | null = null;
  private readonly channelIdentityGenerations = { request: 0, target: 0 };
  private subscriptions: Array<() => void> = [];
  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.context?.config);
  }
  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applyGatewaySnapshot(snapshot)),
      this.context.gateway.subscribeEvents((event) => {
        if (
          !this.identityBusy &&
          !this.channelIdentityBusy.mutation &&
          event.event === "sessions.changed" &&
          asOptionalRecord(event.payload)?.reason === "profile-identity"
        ) {
          this.advanceIdentityRequest();
          this.identityLoading = false;
          void this.loadIdentity();
        }
      }),
      this.context.agents.subscribe(() => this.requestUpdate()),
      this.context.agentIdentity.subscribe(() => this.requestUpdate()),
    ];
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.advanceIdentityRequest(true);
    this.client = null;
    this.connected = false;
    this.connecting = false;
    this.canWrite = false;
    this.connectionScopes = null;
    this.channelIdentityProfileId = null;
    this.identityProfileReady = false;
    this.channelIdentityBusy = { loading: false, mutation: false };
    super.disconnectedCallback();
  }

  private advanceIdentityRequest(targetChanged = false) {
    const request = ++this.identityRequestId;
    this.channelIdentityGenerations.request = request;
    if (targetChanged) {
      this.channelIdentityGenerations.target += 1;
    }
    return request;
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const nextConnected = snapshot.phase === "connected";
    const nextCanWrite = nextConnected && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const writeAccessChanged = nextCanWrite !== this.canWrite;
    const connectionChanged = nextConnected !== this.connected;
    const grantedScopes = snapshot.hello?.auth?.scopes ?? null;
    const nextConnectionScopes = nextConnected ? (grantedScopes ? [...grantedScopes] : null) : null;
    const connectionScopesChanged = !sameConnectionScopes(
      this.connectionScopes,
      nextConnectionScopes,
    );
    const nextSelfUser = nextConnected
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : null;
    const selfProfileChanged =
      nextSelfUser?.id !== this.selfUser?.id ||
      nextSelfUser?.identity?.id !== this.selfUser?.identity?.id;
    const identityTargetChanged = clientChanged || connectionChanged || selfProfileChanged;
    const identitySourceChanged =
      identityTargetChanged || writeAccessChanged || connectionScopesChanged;
    this.client = snapshot.client;
    this.connected = nextConnected;
    this.connecting = snapshot.phase === "connecting" || snapshot.phase === "reconnecting";
    this.canWrite = nextCanWrite;
    // Hello records this connection's negotiated grants, not the profile's role ceiling.
    this.connectionScopes = nextConnectionScopes;
    this.selfUser = nextSelfUser;
    // connected/client are plain fields; an unidentified connect or
    // disconnect changes no @state, so the render branch must be invalidated
    // explicitly or the page sticks on the stale offline/connected view.
    this.requestUpdate();
    if (identitySourceChanged) {
      this.advanceIdentityRequest(identityTargetChanged);
      this.ownProfile = null;
      this.displayName = "";
      this.gitCoauthorEnabled = true;
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
      this.identityProfileReady = false;
      this.channelIdentityBusy = {
        loading: false,
        mutation: identityTargetChanged ? false : this.channelIdentityBusy.mutation,
      };
      if (identityTargetChanged) {
        this.channelIdentityProfileId = null;
      }
    }
    if (!nextConnected || !snapshot.client) {
      return;
    }
    if (identitySourceChanged) {
      void this.loadIdentity();
    }
    void this.context.agents.ensureList().then((list) => {
      if (list) {
        void this.context.agentIdentity.ensure([list.defaultId]);
      }
    });
  }

  private async loadIdentity() {
    const client = this.client;
    if (!client || !this.connected || this.identityLoading) {
      return;
    }
    const requestId = this.advanceIdentityRequest();
    const currentProfile = this.ownProfile;
    const displayNameDraft = this.displayName;
    const hasUnsavedDisplayName =
      currentProfile !== null && displayNameDraft.trim() !== (currentProfile.displayName ?? "");
    this.identityLoading = true;
    this.identityError = null;
    this.identityProfileReady = false;
    try {
      const profile = await this.context.gateway.loadSelfProfile();
      if (requestId !== this.identityRequestId) {
        return;
      }
      this.ownProfile = profile;
      this.channelIdentityProfileId = profile?.id ?? null;
      this.identityProfileReady = true;
      if (!profile) {
        return;
      }
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
      this.gitCoauthorEnabled = true;
      if (profile.githubIdentity) {
        const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
        if (requestId !== this.identityRequestId) {
          return;
        }
        const preferences = await loadUserPreferences(client, profile.id, {
          keys: [GIT_COAUTHOR_PREFERENCE_KEY],
        });
        if (requestId !== this.identityRequestId) {
          return;
        }
        this.gitCoauthorEnabled =
          preferences.status === "ok" &&
          isGitCoauthorCreditEnabled(preferences.entries[GIT_COAUTHOR_PREFERENCE_KEY]);
      }
    } catch (error) {
      if (requestId === this.identityRequestId) {
        this.identityError = formatUiError(error, t("profilePage.identity.profileUnavailable"));
      }
    } finally {
      if (requestId === this.identityRequestId) {
        this.identityLoading = false;
      }
    }
  }

  private async saveIdentity(change: IdentityChange) {
    const client = this.client;
    const profile = this.ownProfile;
    if (
      !client ||
      !profile ||
      !this.canWrite ||
      this.identityBusy ||
      this.identityLoading ||
      (change.kind === "git-coauthor" && !profile.githubIdentity)
    ) {
      return;
    }
    this.identityBusy = change.kind;
    this.identityError = null;
    const identityRequestId = this.identityRequestId;
    const isCurrent = () => client === this.client && identityRequestId === this.identityRequestId;
    try {
      switch (change.kind) {
        case "display-name": {
          const result = await client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
            profileId: profile.id,
            displayName: this.displayName.trim() || null,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = result.profile.displayName ?? "";
          this.context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
          break;
        }
        case "avatar": {
          assertUploadsEnabled(this.context.config);
          const displayNameDraft = this.displayName;
          const hasUnsavedDisplayName = displayNameDraft.trim() !== (profile.displayName ?? "");
          const selfAvatarUrlBefore =
            this.selfUser?.id === profile.id ? this.selfUser.avatarUrl : undefined;
          const avatar = await processProfileAvatar(change.file);
          if (!isCurrent()) {
            return;
          }
          assertUploadsEnabled(this.context.config);
          const result = await client.request<UsersSetAvatarResult>("users.setAvatar", {
            profileId: profile.id,
            mime: avatar.mime,
            avatarBase64: avatar.avatarBase64,
          });
          if (!isCurrent()) {
            return;
          }
          this.ownProfile = result.profile;
          this.displayName = hasUnsavedDisplayName
            ? displayNameDraft
            : (result.profile.displayName ?? "");
          const avatarUrl = userProfileAvatarUrl(
            this.context.gateway.connection.gatewayUrl,
            result.profile.id,
            result.avatarRevision,
            this.context.resourceBasePath,
          );
          const presenceAvatarChanged =
            this.selfUser?.id === result.profile.id &&
            this.selfUser.avatarUrl !== selfAvatarUrlBefore;
          if (avatarUrl && !presenceAvatarChanged) {
            this.context.gateway.updateSelfUser?.({ avatarUrl });
          }
          break;
        }
        case "git-coauthor": {
          const result = await saveUserPreferences(client, {
            entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: change.enabled },
          });
          if (!isCurrent()) {
            return;
          }
          if (result.status !== "ok") {
            throw new Error(t("profilePage.identity.profileUnavailable"));
          }
          this.gitCoauthorEnabled = change.enabled;
          return;
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.identityError =
          change.kind === "avatar" && error instanceof ProfileAvatarError
            ? t(
                error.code === "too-large"
                  ? "profilePage.identity.avatarErrors.tooLarge"
                  : error.code === "source-too-large"
                    ? "profilePage.identity.avatarErrors.sourceTooLarge"
                    : "profilePage.identity.avatarErrors.invalid",
              )
            : formatUiError(error, t("profilePage.identity.profileUnavailable"));
      }
      return;
    } finally {
      if (isCurrent() && this.identityBusy === change.kind) {
        this.identityBusy = null;
      }
    }
    if (isCurrent()) {
      void this.loadIdentity();
    }
  }

  private renderIdentity() {
    if (!this.selfUser || !this.ownProfile) {
      return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.identity}>
        ${renderSettingsSection(
          { title: t("profilePage.identity.title") },
          this.identityLoading
            ? renderSettingsLoadingSkeleton({ label: t("profilePage.identity.loading"), rows: 2 })
            : renderSettingsEmpty(
                this.identityError ??
                  t(
                    !this.selfUser
                      ? "profilePage.identity.unidentified"
                      : "profilePage.identity.profileUnavailable",
                  ),
              ),
        )}
      </div>`;
    }
    // The gateway route serves an uploaded avatar first and its private Gravatar
    // fallback second, while a 404 still leaves the viewer-avatar initials visible.
    const avatarUrl =
      this.selfUser?.id === this.ownProfile.id && this.selfUser.avatarUrl
        ? this.selfUser.avatarUrl
        : userProfileAvatarUrl(
            this.context.gateway.connection.gatewayUrl,
            this.ownProfile.id,
            this.ownProfile.updatedAt,
            this.context.resourceBasePath,
          );
    return renderIdentitySection({
      config: this.context.config,
      profile: this.ownProfile,
      canWrite: this.canWrite,
      avatarUrl,
      displayName: this.displayName,
      gitCoauthorEnabled: this.gitCoauthorEnabled,
      busy: this.identityLoading ? "loading" : this.identityBusy,
      error: this.identityError,
      onDisplayNameInput: (value) => {
        this.displayName = value;
      },
      onSaveDisplayName: () => void this.saveIdentity({ kind: "display-name" }),
      onAvatarSelect: (file) => void this.saveIdentity({ kind: "avatar", file }),
      onGitCoauthorChange: (enabled) => void this.saveIdentity({ kind: "git-coauthor", enabled }),
    });
  }

  private renderConnectionAccess() {
    const scopes = this.connectionScopes;
    const summary =
      scopes === null
        ? "unknown"
        : scopes.length === 0
          ? "none"
          : ((
              [
                ["operator.admin", "admin"],
                ["operator.write", "write"],
                ["operator.sessions.write", "sessionWrite"],
                ["operator.read", "read"],
                ["operator.sessions.read", "sessionRead"],
              ] as const
            ).find(([scope]) => scopes.includes(scope))?.[1] ?? "limited");
    return html`<div id="settings-profile-access">
      ${renderSettingsSection(
        { title: t("profilePage.access.title") },
        html`
          ${renderSettingsRow({
            title: t(`profilePage.access.${summary}`),
            description: t("profilePage.access.limits"),
          })}
          ${renderSettingsRow({
            title: t("profilePage.access.help"),
            description: t("profilePage.access.nextStep"),
            stackedOnNarrow: true,
            control: html`<button
              type="button"
              class="btn"
              ?disabled=${this.identityBusy !== null || this.channelIdentityBusy.mutation}
              @click=${() => this.context.gateway.connect()}
            >
              ${t("profilePage.access.reconnect")}
            </button>`,
          })}
          <details class="settings-row settings-row--stacked">
            <summary>${t("profilePage.access.details")}</summary>
            ${renderSettingsRow({
              title: t("profilePage.access.scopes"),
              description: t("profilePage.access.description"),
              stacked: true,
              control: renderSettingsValue(
                scopes === null
                  ? t("profilePage.access.unknown")
                  : scopes.length === 0
                    ? t("profilePage.access.none")
                    : scopes.join(", "),
                { mono: scopes !== null && scopes.length > 0 },
              ),
            })}
          </details>
        `,
      )}
    </div>`;
  }

  private renderModelAccounts() {
    return html`<openclaw-model-accounts
      .identityId=${this.selfUser?.id ?? null}
      .profileId=${this.ownProfile?.id ?? null}
      .personLabel=${
        this.ownProfile
          ? this.ownProfile.displayName?.trim() ||
            this.ownProfile.emails[0] ||
            t("profilePage.modelAccounts.currentPerson")
          : null
      }
    ></openclaw-model-accounts>`;
  }

  private refreshManually() {
    if (
      this.connected &&
      !this.identityBusy &&
      !this.identityLoading &&
      !this.channelIdentityBusy.loading &&
      !this.channelIdentityBusy.mutation
    ) {
      if (this.client) {
        invalidateUserPreferences(this.client);
      }
      void this.loadIdentity();
    }
  }

  private renderHero() {
    const list = this.context.agents.state.agentsList;
    const agentId = list?.defaultId ?? "main";
    const row = list?.agents.find((agent) => agent.id === agentId) ?? { id: agentId };
    return renderProfileHero({
      row,
      user: this.selfUser,
      identity: this.context.agentIdentity.get(agentId),
      avatarLoader: this.heroAvatarLoader,
    });
  }

  private renderBody() {
    const connected = this.connected && this.client !== null;
    const multipleProfiles =
      this.context.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true;
    // Keep the personal editor mounted through transport interruptions so its
    // draft survives, but hide the host on single-user Gateways so it adds no layout gap.
    return renderSettingsPage(html`
      ${
        connected
          ? html`${this.renderHero()} ${this.renderConnectionAccess()} ${this.renderIdentity()}
              <openclaw-profile-channel-identities
                .profileId=${this.channelIdentityProfileId}
                .visible=${this.ownProfile !== null && this.ownProfile.id === this.channelIdentityProfileId}
                .profileReady=${this.identityProfileReady}
                .identityBusy=${this.identityLoading || this.identityBusy !== null}
                .identityGeneration=${this.identityRequestId}
                .targetGeneration=${this.channelIdentityGenerations.target}
                .generations=${this.channelIdentityGenerations}
                @profile-channel-identities-busy-changed=${(
                  event: CustomEvent<ProfileChannelIdentityBusyState>,
                ) => {
                  this.channelIdentityBusy = event.detail;
                }}
              ></openclaw-profile-channel-identities>`
          : renderSettingsGroup(
              this.connecting
                ? html`<div role="status">
                    ${renderSettingsEmpty(t("profilePage.access.connecting"))}
                  </div>`
                : renderSettingsEmpty(t("profilePage.offline")),
            )
      }
      <openclaw-personal-instructions
        ?hidden=${!connected || !multipleProfiles}
      ></openclaw-personal-instructions>
      ${
        connected
          ? html`
              ${this.renderModelAccounts()}
              <openclaw-github-connections></openclaw-github-connections>
              ${renderSettingsGroup(
                renderSettingsNavRow({
                  title: t("profilePage.usageStatistics"),
                  description: t("profilePage.usageStatisticsDescription"),
                  onClick: () => this.context.navigate("usage"),
                }),
              )}
            `
          : nothing
      }
    `);
  }

  override render() {
    return this.heroAvatarLoader.withActiveRoutes(() => this.renderContent());
  }

  private renderContent() {
    return html`
      <section class="content-header" ${shellLayoutTraits({ toolbarHeader: true })}>
        <div>
          <h1 class="page-title">${titleForRoute("profile")}</h1>
          <div class="page-subtitle">
            ${subtitleForRoute("profile")} ${renderLearnMoreLink(PROFILE_DOCS_URL)}
          </div>
        </div>
        ${
          this.connected
            ? html`<button
                class="btn profile-refresh"
                ?disabled=${
                  this.identityLoading ||
                  this.identityBusy !== null ||
                  this.channelIdentityBusy.loading ||
                  this.channelIdentityBusy.mutation
                }
                @click=${() => this.refreshManually()}
              >
                ${this.identityLoading ? t("common.refreshing") : t("common.refresh")}
              </button>`
            : nothing
        }
      </section>
      ${renderSettingsWorkspace(this.renderBody())}
    `;
  }
}

if (!customElements.get("openclaw-profile-page")) {
  customElements.define("openclaw-profile-page", ProfilePage);
}
