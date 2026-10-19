import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createSignal, onCleanup, Show } from "solid-js";
import type {
  UserProfile,
  UsersSetAvatarResult,
  UsersSetDisplayNameResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import {
  GATEWAY_OWNER_PROFILE_ID,
  GIT_COAUTHOR_PREFERENCE_KEY,
  isGitCoauthorCreditEnabled,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorSelfReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
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
import { projectOwner } from "../../lib/reactive/projection.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";
import "../../styles/profile.css";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";
import { IdentitySection } from "./identity-section.tsx";
import { ModelAccounts } from "./model-accounts.tsx";
import { PersonalInstructions } from "./personal-instructions.tsx";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import { ProfileHero } from "./profile-hero.tsx";

registerEnglishCatalog(registerModelAccountsEnglish);
registerEnglishCatalog(registerProfileEnglish);

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

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
  identityReady = false;
  connecting = false;
  canRead = false;
  canWrite = false;
  connectionScopes: readonly string[] | null = null;
  identityRequestId = 0;
  hello: ApplicationGatewaySnapshot["hello"] | undefined;

  constructor(
    readonly context: ApplicationContext,
    readonly publish: () => void,
  ) {}
  dispose() {
    this.identityRequestId += 1;
    this.client = null;
    this.connected = false;
    this.identityReady = false;
  }
  applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.client;
    const nextConnected = snapshot.phase === "connected";
    // Hello can precede users.self; unresolved identity is not a sign-out.
    const identityReady = nextConnected && snapshot.selfUser !== undefined;
    const nextCanRead = hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null);
    const nextCanWrite = nextConnected && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const connectionChanged =
      nextConnected !== this.connected ||
      identityReady !== this.identityReady ||
      (nextConnected && this.hello !== snapshot.hello);
    const nextSelfUser = identityReady
      ? resolveCurrentSelfUser({ snapshotUser: snapshot.selfUser })
      : clientChanged
        ? null
        : this.selfUser;
    const selfProfileChanged =
      nextSelfUser?.id !== this.selfUser?.id ||
      nextSelfUser?.identity?.id !== this.selfUser?.identity?.id;
    const writeAccessLost =
      nextConnected &&
      !nextCanWrite &&
      this.connectionScopes?.some(
        (scope) => scope === "operator.write" || scope === "operator.admin",
      );
    const readAccessLost = nextConnected && this.canRead && !nextCanRead;
    const identitySourceChanged =
      clientChanged || selfProfileChanged || writeAccessLost || readAccessLost;
    this.client = snapshot.client;
    this.connected = nextConnected;
    this.identityReady = identityReady;
    this.hello = snapshot.hello;
    this.connecting = snapshot.phase === "connecting" || snapshot.phase === "reconnecting";
    this.canRead = nextConnected ? nextCanRead : clientChanged ? false : this.canRead;
    this.canWrite = nextCanWrite && identityReady;
    // Hello records this connection's negotiated grants, not the profile's role ceiling.
    this.connectionScopes =
      nextConnected || clientChanged
        ? (snapshot.hello?.auth?.scopes ?? null)
        : this.connectionScopes;
    this.selfUser = nextSelfUser;
    if (identitySourceChanged || connectionChanged) {
      this.identityRequestId += 1;
      this.identityLoading = false;
      this.identityBusy = null;
      this.identityError = null;
    }
    if (identitySourceChanged) {
      this.ownProfile = null;
      this.displayName = "";
      this.gitCoauthorEnabled = true;
    }
    this.publish();
    if (!identityReady || !snapshot.client) {
      return;
    }
    if (identitySourceChanged || connectionChanged) {
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
    if (!client || !this.identityReady || !this.canRead || this.identityLoading) {
      return;
    }
    const requestId = ++this.identityRequestId;
    const currentProfile = this.ownProfile;
    const displayNameDraft = this.displayName;
    const hasUnsavedDisplayName =
      currentProfile !== null && displayNameDraft.trim() !== (currentProfile.displayName ?? "");
    this.identityLoading = true;
    this.identityError = null;
    this.publish();
    try {
      const profile = await this.context.gateway.loadSelfProfile();
      if (requestId !== this.identityRequestId) {
        return;
      }
      this.ownProfile = profile;
      if (!profile) {
        return;
      }
      this.displayName = hasUnsavedDisplayName ? displayNameDraft : (profile.displayName ?? "");
      this.gitCoauthorEnabled = true;
      this.publish();
      // Consent belongs to the person, not to a display-primary GitHub account.
      if (profile.id !== GATEWAY_OWNER_PROFILE_ID) {
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
      (change.kind === "git-coauthor" && profile.id === GATEWAY_OWNER_PROFILE_ID)
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
    if (this.identityReady && !this.identityBusy && !this.identityLoading) {
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
  const agents = projectOwner(context.agents, (source) => source.state.agentsList);
  const identities = projectOwner(context.agentIdentity, (source) => source);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ProfileState(context, () => setRevision((value) => value + 1));
  const view = () => {
    revision();
    return state;
  };
  // Retire identity requests synchronously when connection authority changes.
  const stopGateway = context.gateway.subscribe((snapshot) => state.applyGatewaySnapshot(snapshot));
  const stopEvents = context.gateway.subscribeEvents((event) => {
    if (
      !state.identityBusy &&
      event.event === "sessions.changed" &&
      asOptionalRecord(event.payload)?.reason === "profile-identity"
    ) {
      state.identityRequestId += 1;
      state.identityLoading = false;
      void state.loadIdentity();
    }
  });
  state.applyGatewaySnapshot(context.gateway.snapshot);
  onCleanup(() => {
    stopGateway();
    stopEvents();
    state.dispose();
  });
  const connected = () => view().connected && view().client !== null;
  const hasPresentation = () =>
    connected() || view().connectionScopes !== null || view().selfUser !== null;
  const agent = () => {
    const list = agents.read();
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
                !view().identityReady || view().identityLoading || view().identityBusy !== null
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
            when={hasPresentation()}
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
              identity={identities.read().get(agent().id)}
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
                      disabled={view().identityBusy !== null}
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
                    {view().identityLoading || (view().connected && !view().identityReady) ? (
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
                connected={view().identityReady}
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
          </Show>
          <PersonalInstructions
            hidden={
              !hasPresentation() ||
              view().context.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities !==
                true
            }
          />
          <Show when={hasPresentation()}>
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
