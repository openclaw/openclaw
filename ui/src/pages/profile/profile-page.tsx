import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createSignal, onCleanup, Show } from "solid-js";
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
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { invalidateUserPreferences, saveUserPreferences } from "../../app/user-prefs-cache.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveCurrentSelfUser } from "../../app/user-profile.ts";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsNavRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { GitHubConnections } from "../../features/github-connections/github-connections.tsx";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";
import "../../styles/profile.css";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import { IdentitySection } from "./identity-section.tsx";
import { ModelAccounts } from "./model-accounts.tsx";
import { PersonalInstructions } from "./personal-instructions.tsx";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import type { ProfileChannelIdentityBusyState } from "./profile-channel-identities-controller.ts";
import { ProfileChannelIdentities } from "./profile-channel-identities.tsx";
import { ProfileHero } from "./profile-hero.tsx";

registerEnglishCatalog(registerModelAccountsEnglish);
registerEnglishCatalog(registerProfileEnglish);

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

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

type IdentityChange =
  | { kind: "display-name" }
  | { kind: "avatar"; file: File }
  | { kind: "git-coauthor"; enabled: boolean };

class ProfileState {
  selfUser: AuthenticatedUser | null = null;
  ownProfile: UserProfile | null = null;
  displayName = "";
  gitCoauthorEnabled = true;
  identityLoading = false;
  identityBusy: IdentityChange["kind"] | null = null;
  identityError: string | null = null;

  client: GatewayBrowserClient | null = null;
  connected = false;
  connecting = false;
  canWrite = false;
  connectionScopes: readonly string[] | null = null;
  identityRequestId = 0;
  identityProfileReady = false;
  channelIdentityProfileId: string | null = null;
  channelIdentityBusy: ProfileChannelIdentityBusyState = { loading: false, mutation: false };
  channelIdentityGenerations = { request: 0, target: 0 };

  constructor(
    readonly context: ApplicationContext,
    readonly publish: () => void,
  ) {}
  dispose() {
    this.advanceIdentityRequest(true);
    this.client = null;
    this.connected = false;
    this.channelIdentityProfileId = null;
    this.identityProfileReady = false;
    this.channelIdentityBusy = { loading: false, mutation: false };
  }
  advanceIdentityRequest(targetChanged = false) {
    const request = ++this.identityRequestId;
    this.channelIdentityGenerations.request = request;
    if (targetChanged) {
      this.channelIdentityGenerations.target += 1;
    }
    return request;
  }
  applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
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
    if (identitySourceChanged) {
      this.advanceIdentityRequest(identityTargetChanged);
      if (identityTargetChanged || writeAccessChanged) {
        this.ownProfile = null;
        this.displayName = "";
        this.gitCoauthorEnabled = true;
      }
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
    this.publish();
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

  async loadIdentity() {
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
    this.publish();
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
      this.publish();
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
        this.publish();
      }
    }
  }

  async saveIdentity(change: IdentityChange) {
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
    this.publish();
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
        this.publish();
      }
    }
    if (isCurrent()) {
      void this.loadIdentity();
    }
  }

  refreshManually() {
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
}

function accessSummary(scopes: readonly string[] | null) {
  if (scopes === null) {
    return "unknown";
  }
  if (scopes.length === 0) {
    return "none";
  }
  return (
    (
      [
        ["operator.admin", "admin"],
        ["operator.write", "write"],
        ["operator.sessions.write", "sessionWrite"],
        ["operator.read", "read"],
        ["operator.sessions.read", "sessionRead"],
      ] as const
    ).find(([scope]) => scopes.includes(scope))?.[1] ?? "limited"
  );
}

export function ProfilePage() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ProfileState(context, () => setRevision((value) => value + 1));
  const view = () => {
    revision();
    return state;
  };
  const handleChannelIdentityBusyChange = (busyState: ProfileChannelIdentityBusyState) => {
    state.channelIdentityBusy = busyState;
    state.publish();
  };
  const stops = [
    context.gateway.subscribe((snapshot) => state.applyGatewaySnapshot(snapshot)),
    context.agents.subscribe(state.publish),
    context.agentIdentity.subscribe(state.publish),
    context.gateway.subscribeEvents((event) => {
      if (
        !state.identityBusy &&
        !state.channelIdentityBusy.mutation &&
        event.event === "sessions.changed" &&
        asOptionalRecord(event.payload)?.reason === "profile-identity"
      ) {
        state.advanceIdentityRequest();
        state.identityLoading = false;
        void state.loadIdentity();
      }
    }),
  ];
  state.applyGatewaySnapshot(context.gateway.snapshot);
  onCleanup(() => {
    stops.forEach((stop) => stop());
    state.dispose();
  });
  const connected = () => view().connected && view().client !== null;
  const agent = () => {
    revision();
    const list = context.agents.state.agentsList;
    const id = list?.defaultId ?? "main";
    return list?.agents.find((row) => row.id === id) ?? { id };
  };
  const avatarUrl = () => {
    const profile = view().ownProfile;
    if (!profile) {
      return null;
    }
    return view().selfUser?.id === profile.id && view().selfUser?.avatarUrl
      ? view().selfUser!.avatarUrl!
      : userProfileAvatarUrl(
          context.gateway.connection.gatewayUrl,
          profile.id,
          profile.updatedAt,
          context.resourceBasePath,
        );
  };

  return (
    <openclaw-profile-page>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{titleForRoute("profile")}</h1>
            <div class="page-subtitle">
              {subtitleForRoute("profile")} <LearnMoreLink url={PROFILE_DOCS_URL} />
            </div>
          </div>
          <Show when={view().connected}>
            <button
              class="btn profile-refresh"
              disabled={
                view().identityLoading ||
                view().identityBusy !== null ||
                view().channelIdentityBusy.loading ||
                view().channelIdentityBusy.mutation
              }
              onClick={() => state.refreshManually()}
            >
              {view().identityLoading ? t("common.refreshing") : t("common.refresh")}
            </button>
          </Show>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <SettingsPage>
          <Show
            when={connected()}
            fallback={
              <SettingsGroup>
                {view().connecting ? (
                  <div role="status">
                    <SettingsEmpty message={t("profilePage.access.connecting")} />
                  </div>
                ) : (
                  <SettingsEmpty message={t("profilePage.offline")} />
                )}
              </SettingsGroup>
            }
          >
            <ProfileHero
              row={agent()}
              user={view().selfUser}
              identity={context.agentIdentity.get(agent().id)}
            />
            <div id="settings-profile-access">
              <SettingsSection title={t("profilePage.access.title")}>
                <SettingsRow
                  title={t(`profilePage.access.${accessSummary(view().connectionScopes)}`)}
                  description={t("profilePage.access.limits")}
                />
                <SettingsRow
                  title={t("profilePage.access.help")}
                  description={t("profilePage.access.nextStep")}
                  stackedOnNarrow
                  control={
                    <button
                      type="button"
                      class="btn"
                      disabled={view().identityBusy !== null || view().channelIdentityBusy.mutation}
                      onClick={() => context.gateway.connect()}
                    >
                      {t("profilePage.access.reconnect")}
                    </button>
                  }
                />
                <details class="settings-row settings-row--stacked">
                  <summary>{t("profilePage.access.details")}</summary>
                  <SettingsRow
                    title={t("profilePage.access.scopes")}
                    description={t("profilePage.access.description")}
                    stacked
                    control={
                      <SettingsValue
                        mono={
                          view().connectionScopes !== null && view().connectionScopes!.length > 0
                        }
                        value={
                          view().connectionScopes === null
                            ? t("profilePage.access.unknown")
                            : view().connectionScopes!.length === 0
                              ? t("profilePage.access.none")
                              : view().connectionScopes!.join(", ")
                        }
                      />
                    }
                  />
                </details>
              </SettingsSection>
            </div>
            <Show
              when={view().selfUser && view().ownProfile}
              fallback={
                <div id={PROFILE_SETTINGS_TARGET_IDS.identity}>
                  <SettingsSection title={t("profilePage.identity.title")}>
                    {view().identityLoading ? (
                      <SettingsLoadingSkeleton label={t("profilePage.identity.loading")} rows={2} />
                    ) : (
                      <SettingsEmpty
                        message={
                          view().identityError ??
                          t(
                            !view().selfUser
                              ? "profilePage.identity.unidentified"
                              : "profilePage.identity.profileUnavailable",
                          )
                        }
                      />
                    )}
                  </SettingsSection>
                </div>
              }
            >
              <IdentitySection
                config={context.config}
                profile={view().ownProfile!}
                canWrite={view().canWrite}
                avatarUrl={avatarUrl()}
                displayName={view().displayName}
                gitCoauthorEnabled={view().gitCoauthorEnabled}
                busy={view().identityLoading ? "loading" : view().identityBusy}
                error={view().identityError}
                onDisplayNameInput={(value) => {
                  state.displayName = value;
                  state.publish();
                }}
                onSaveDisplayName={() => void state.saveIdentity({ kind: "display-name" })}
                onAvatarSelect={(file) => void state.saveIdentity({ kind: "avatar", file })}
                onGitCoauthorChange={(enabled) =>
                  void state.saveIdentity({ kind: "git-coauthor", enabled })
                }
              />
            </Show>
            <ProfileChannelIdentities
              profileId={view().channelIdentityProfileId}
              visible={
                view().ownProfile !== null &&
                view().ownProfile!.id === view().channelIdentityProfileId
              }
              profileReady={view().identityProfileReady}
              identityBusy={view().identityLoading || view().identityBusy !== null}
              identityGeneration={view().identityRequestId}
              targetGeneration={view().channelIdentityGenerations.target}
              generations={view().channelIdentityGenerations}
              onBusyStateChange={handleChannelIdentityBusyChange}
            />
          </Show>
          <PersonalInstructions
            hidden={
              !connected() ||
              view().context.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities !==
                true
            }
          />
          <Show when={connected()}>
            <ModelAccounts
              identityId={view().selfUser?.id ?? null}
              profileId={view().ownProfile?.id ?? null}
              personLabel={
                view().ownProfile
                  ? view().ownProfile!.displayName?.trim() ||
                    view().ownProfile!.emails[0] ||
                    t("profilePage.modelAccounts.currentPerson")
                  : null
              }
            />
            <GitHubConnections />
            <SettingsGroup>
              <SettingsNavRow
                title={t("profilePage.usageStatistics")}
                description={t("profilePage.usageStatisticsDescription")}
                onClick={() => context.navigate("usage")}
              />
            </SettingsGroup>
          </Show>
        </SettingsPage>
      </SettingsWorkspace>
    </openclaw-profile-page>
  );
}
