import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  refresh,
  Show,
} from "solid-js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/index.ts";
import { userProfileDisplayName } from "../../../../src/shared/user-profile-display-name.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ScopeUpgradeOwner } from "../../app/device-scope-upgrade-owner.runtime.ts";
import { ScopeUpgradeActions, scopeUpgradeText } from "../../components/scope-upgrade-actions.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsSectionHelp } from "../../components/solid/settings-section-help.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsNavRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
  SettingsPageHeader,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { GitHubConnections } from "../../features/github-connections/github-connections.tsx";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../components/solid/viewer-facepile.tsx";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import "../../styles/profile.css";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
import { DiscordIdentity } from "./discord-identity.tsx";
import { ModelAccounts } from "./model-accounts.tsx";
import { PersonalInstructions } from "./personal-instructions.tsx";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";
import { ProfileHero } from "./profile-hero.tsx";
import { type IdentityChange, ProfileState } from "./profile-state.ts";

registerRouteSubtitlesEnglish();

registerEnglishCatalog(registerModelAccountsEnglish);
registerEnglishCatalog(registerProfileEnglish);

const PROFILE_DOCS_URL = "https://docs.openclaw.ai/concepts/user-model";

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
  const upgrade = projectOwner(context.scopeUpgrade, (source) =>
    source.state.phase === "hidden" ? null : source.state,
  );
  onSettled(() => context.scopeUpgrade.activate(ScopeUpgradeOwner));
  const agents = projectOwner(context.agents, (source) => source.state.agentsList);
  const identities = projectOwner(context.agentIdentity, (source) => source);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ProfileState(context, () => setRevision((value) => value + 1));
  const view = () => {
    revision();
    return state;
  };
  const canWrite = createMemo(() => view().canWrite);
  const identityScope = createMemo(() => view().identityScope);
  const presentation = createMemo(() => {
    const scope = identityScope();
    const [saving, setSaving] = createOptimistic<IdentityChange["kind"] | null>(null);
    const [gitCoauthorEnabled, setGitCoauthorEnabled] = createOptimistic(
      () => view().gitCoauthorEnabled,
    );
    const [prAttributionEnabled, setPrAttributionEnabled] = createOptimistic(
      () => view().prAttributionEnabled,
    );
    return {
      scope,
      saving,
      setSaving,
      gitCoauthorEnabled,
      setGitCoauthorEnabled,
      prAttributionEnabled,
      setPrAttributionEnabled,
    };
  });
  const identityBusy = () => presentation().saving() ?? view().identityBusy;
  const presentMutation = action(function* (
    current: ReturnType<typeof presentation>,
    pending: Promise<void>,
    retired: Promise<void>,
    change: IdentityChange,
  ) {
    const isCurrent = () =>
      current.scope === state.identityScope && retired === state.presentationLifetime.promise;
    try {
      if (isCurrent()) {
        current.setSaving(change.kind);
        if (change.kind === "git-coauthor") {
          current.setGitCoauthorEnabled(change.enabled);
        } else if (change.kind === "pr-attribution") {
          current.setPrAttributionEnabled(change.enabled);
        } else {
          affects(identityRead);
        }
      }
      yield Promise.race([pending, retired]);
      if (isCurrent()) {
        yield refresh(
          change.kind === "git-coauthor"
            ? current.gitCoauthorEnabled
            : change.kind === "pr-attribution"
              ? current.prAttributionEnabled
              : identityRead,
        );
      }
    } catch (error) {
      if (isCurrent()) {
        const message = formatUiError(error, t("profilePage.identity.profileUnavailable"));
        if (change.kind === "git-coauthor" || change.kind === "pr-attribution") {
          state.attributionError = message;
        } else {
          state.identityError = message;
        }
        state.publish();
      }
    }
  });
  async function saveIdentity(change: IdentityChange) {
    const current = presentation();
    const retired = state.presentationLifetime.promise;
    const pending = state.saveIdentity(change);
    if (state.identityBusy !== change.kind) {
      return pending;
    }
    // Let the owner's admission publish before joining the presentation action.
    await Promise.resolve();
    return presentMutation(current, pending, retired, change);
  }
  onSettled(() => {
    // Retire before route rendering; pending actions can park reactive cleanup.
    const stopRoute = context.router.subscribe(() => {
      state.retirePresentation();
      state.publish();
    });
    // Retire identity requests synchronously when connection authority changes.
    const stopGateway = context.gateway.subscribe((snapshot) =>
      state.applyGatewaySnapshot(snapshot),
    );
    const stopEvents = context.gateway.subscribeEvents((event) => {
      if (
        !state.identityBusy &&
        event.event === "sessions.changed" &&
        asOptionalRecord(event.payload)?.reason === "profile-identity"
      ) {
        state.identityRequestId += 1;
        state.identityLoading = false;
        state.loadIdentity();
      }
    });
    state.applyGatewaySnapshot(context.gateway.snapshot);
    return () => {
      stopRoute();
      stopGateway();
      stopEvents();
      state.dispose();
    };
  });
  const connected = () => view().connected && view().client !== null;
  const hasPresentation = () =>
    connected() || view().connectionScopes !== null || view().selfUser !== null;
  // Reveal the lower sections with the profile, before its preferences finish loading.
  const initialIdentityPending = () =>
    view().ownProfile === null &&
    (view().identityLoading || (view().connected && !view().identityReady));
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

  const identityReceipt = createMemo(() => view().identityReceipt);
  const identityRead = createMemo(() => identityReceipt().result);
  const IdentityContent = (props: { pending: boolean }) => (
    <Show
      when={view().selfUser && view().ownProfile}
      fallback={
        <div id={PROFILE_SETTINGS_TARGET_IDS.identity}>
          <SettingsSection title={t("profilePage.identity.title")}>
            {props.pending || (view().connected && !view().identityReady) ? (
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
      {(profile) => {
        function IdentitySection() {
          const busy = () => identityBusy() ?? (props.pending ? "loading" : null);
          const configuration = createMemo(() => {
            const source = context.config;
            return source ? projectApplicationConfig(source) : null;
          });
          const canUpload = () => configuration()?.read().uploadsEnabled !== false;
          const canEditIdentity = () => latest(canWrite);
          const isOwnerProfile = () => profile().id === GATEWAY_OWNER_PROFILE_ID;
          return (
            <div id={PROFILE_SETTINGS_TARGET_IDS.identity}>
              <SettingsSection
                title={t("profilePage.identity.title")}
                actions={
                  <SettingsSectionHelp
                    id="settings-profile-identity-help"
                    section={t("profilePage.identity.title")}
                  >
                    <p>
                      <strong>{t("profilePage.identity.avatar")}</strong>{" "}
                      {t("profilePage.identity.avatarDescription")}
                    </p>
                    <Show when={!isOwnerProfile()}>
                      <p>
                        <strong>{t("profilePage.identity.linkedEmails")}</strong>{" "}
                        {t("profilePage.identity.linkedEmailsDescription")}
                      </p>
                      <p>
                        <strong>{t("profilePage.discord.title")}</strong>{" "}
                        {t("profilePage.discord.description")}
                      </p>
                    </Show>
                    <p>
                      <strong>{t("profilePage.identity.githubAccount")}</strong>{" "}
                      {isOwnerProfile()
                        ? t("profilePage.identity.ownerGithubDescription")
                        : t("profilePage.identity.githubAccountDescription")}
                      <Show when={!profile().githubIdentity}>
                        {" "}
                        {t("profilePage.identity.githubUnavailableDescription")}
                      </Show>
                    </p>
                  </SettingsSectionHelp>
                }
              >
                <Show when={!canEditIdentity() && view().identityReady}>
                  <SettingsRow title={t("profilePage.identity.writeRequired")} />
                </Show>
                <SettingsRow
                  title={t("profilePage.identity.avatar")}
                  description={t("profilePage.identity.avatarLimits")}
                  control={
                    <span class="identity-avatar-control">
                      <openclaw-viewer-avatar
                        prop:user={{
                          id: profile().id,
                          name: userProfileDisplayName(
                            profile().id,
                            profile().displayName,
                            profile().githubIdentity?.login,
                          ),
                          email: profile().emails[0],
                          avatarUrl: avatarUrl() ?? undefined,
                          watchedSessions: [],
                        }}
                        variant="profile"
                      />
                      <Show when={canEditIdentity() && canUpload()}>
                        <button
                          type="button"
                          class="btn btn--sm"
                          disabled={busy() !== null}
                          onClick={(event) => {
                            const input = event.currentTarget.nextElementSibling;
                            if (
                              canEditIdentity() &&
                              uploadsEnabled(context.config) &&
                              input instanceof HTMLInputElement
                            ) {
                              input.click();
                            }
                          }}
                        >
                          {busy() === "avatar"
                            ? t("profilePage.identity.processingAvatar")
                            : t("profilePage.identity.chooseAvatar")}
                        </button>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          hidden
                          disabled={busy() !== null}
                          onChange={(event) => {
                            const input = event.currentTarget;
                            const file = input.files?.[0];
                            input.value = "";
                            if (file && canEditIdentity() && uploadsEnabled(context.config)) {
                              void saveIdentity({ kind: "avatar", file });
                            }
                          }}
                        />
                      </Show>
                    </span>
                  }
                />
                <SettingsRow
                  title={t("profilePage.identity.displayName")}
                  description={t("profilePage.identity.displayNameDescription")}
                  control={
                    <form
                      class="identity-name-control"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveIdentity({ kind: "display-name" });
                      }}
                    >
                      <input
                        class="settings-input"
                        type="text"
                        maxlength={256}
                        aria-label={t("profilePage.identity.displayName")}
                        value={view().displayName}
                        disabled={
                          !canEditIdentity() || (busy() !== null && busy() !== "display-name")
                        }
                        readonly={busy() === "display-name"}
                        onInput={(event) => {
                          state.displayName = event.currentTarget.value;
                          state.publish();
                        }}
                      />
                      <button
                        type="submit"
                        class="btn btn--sm"
                        disabled={
                          !canEditIdentity() ||
                          busy() !== null ||
                          view().displayName.trim() === (profile().displayName ?? "")
                        }
                      >
                        {busy() === "display-name" ? t("common.saving") : t("common.save")}
                      </button>
                    </form>
                  }
                />
                <Show when={!isOwnerProfile()}>
                  <SettingsRow
                    title={t("profilePage.identity.linkedEmails")}
                    description={
                      profile().emails.length ? (
                        <span class="identity-emails">
                          <For each={profile().emails}>
                            {(email) => <span class="identity-account">{email}</span>}
                          </For>
                        </span>
                      ) : undefined
                    }
                  />
                </Show>
                <Show when={!isOwnerProfile()}>
                  <DiscordIdentity />
                </Show>
                <SettingsRow
                  title={t("profilePage.identity.githubAccount")}
                  description={
                    <span class="settings-row__meta">
                      <SettingsStatus
                        kind={profile().githubIdentity ? "ok" : "muted"}
                        label={t(
                          profile().githubIdentity
                            ? "profilePage.identity.githubVerified"
                            : "profilePage.identity.githubUnavailable",
                        )}
                      />
                      <Show when={profile().githubIdentity}>
                        {(identity) => (
                          <a
                            class="identity-account identity-github-login"
                            href={identity().profileUrl}
                            target={EXTERNAL_LINK_TARGET}
                            rel={buildExternalLinkRel()}
                            title={`@${identity().login}`}
                          >
                            @{identity().login}
                          </a>
                        )}
                      </Show>
                    </span>
                  }
                />
                <Show when={view().identityError}>
                  <div class="settings-row identity-error" role="alert">
                    <span class="settings-row__desc">{view().identityError}</span>
                  </div>
                </Show>
              </SettingsSection>
            </div>
          );
        }
        return <IdentitySection />;
      }}
    </Show>
  );

  const AttributionSection = () => {
    const busy = () => identityBusy() ?? (view().identityLoading ? "loading" : null);
    const canEdit = () => latest(canWrite);
    const isOwnerProfile = () => view().ownProfile?.id === GATEWAY_OWNER_PROFILE_ID;
    return (
      <Show when={view().selfUser && view().ownProfile}>
        <div id={PROFILE_SETTINGS_TARGET_IDS.attribution}>
          <SettingsSection
            title={t("profilePage.identity.attribution")}
            actions={
              <SettingsSectionHelp
                id="settings-profile-attribution-help"
                section={t("profilePage.identity.attribution")}
              >
                <p>
                  <strong>{t("profilePage.identity.gitCoauthor")}</strong>{" "}
                  {t("profilePage.identity.gitCoauthorDescription")}
                </p>
                <p>
                  <strong>{t("profilePage.identity.prAttribution")}</strong>{" "}
                  {t("profilePage.identity.prAttributionDescription")}
                </p>
              </SettingsSectionHelp>
            }
          >
            <SettingsToggleRow
              title={t("profilePage.identity.gitCoauthor")}
              description={
                // Publication selects its host independently of the displayed primary account.
                isOwnerProfile()
                  ? t("profilePage.identity.ownerGitCoauthorDescription")
                  : t("profilePage.identity.gitCoauthorShort")
              }
              checked={!isOwnerProfile() && presentation().gitCoauthorEnabled()}
              disabled={
                !canEdit() || (busy() !== null && busy() !== "git-coauthor") || isOwnerProfile()
              }
              saving={busy() === "git-coauthor"}
              onChange={(enabled) => void saveIdentity({ kind: "git-coauthor", enabled })}
            />
            <SettingsToggleRow
              title={t("profilePage.identity.prAttribution")}
              description={
                <>
                  {t("profilePage.identity.prAttributionShort")}{" "}
                  <a
                    class="identity-attribution-link"
                    href="https://openclaw.ai"
                    target={EXTERNAL_LINK_TARGET}
                    rel={buildExternalLinkRel()}
                  >
                    {t("profilePage.identity.prAttributionLink")}
                  </a>
                </>
              }
              checked={presentation().prAttributionEnabled()}
              disabled={!canEdit() || busy() !== null}
              onChange={(enabled) => void saveIdentity({ kind: "pr-attribution", enabled })}
            />
            <Show when={view().attributionError}>
              <div class="settings-row identity-error" role="alert">
                <span class="settings-row__desc">{view().attributionError}</span>
              </div>
            </Show>
          </SettingsSection>
        </div>
      </Show>
    );
  };

  return (
    <openclaw-profile-page>
      <SettingsPageHeader
        title={titleForRoute("profile")}
        subtitle={
          <>
            {subtitleForRoute("profile")} <LearnMoreLink url={PROFILE_DOCS_URL} />
          </>
        }
        actions={
          <Show when={view().connected}>
            <RefreshButton
              class="profile-refresh"
              label={view().identityLoading ? t("common.refreshing") : t("common.refresh")}
              busy={view().identityLoading}
              disabled={!view().identityReady || identityBusy() !== null}
              onClick={() => state.refreshManually()}
            />
          </Show>
        }
      />
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
            <Show when={view().selfUser || !initialIdentityPending()}>
              <ProfileHero
                row={agent()}
                user={view().selfUser}
                identity={identities.read().get(agent().id)}
              />
            </Show>
            <Show when={!initialIdentityPending()} fallback={<IdentityContent pending={true} />}>
              <Errored
                fallback={(error, reset) => (
                  <>
                    <div class="callout danger" role="alert">
                      {formatUiError(error())}{" "}
                      <button
                        class="btn btn--sm"
                        onClick={() => {
                          state.refreshManually();
                          reset();
                        }}
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                    <IdentityContent pending={false} />
                  </>
                )}
              >
                <Loading on={latest(identityScope)} fallback={<IdentityContent pending={true} />}>
                  {(latest(identityRead), null)}
                  <IdentityContent pending={isPending(identityRead)} />
                </Loading>
              </Errored>
            </Show>
          </Show>
          <PersonalInstructions
            hidden={
              initialIdentityPending() ||
              !hasPresentation() ||
              view().context.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities !==
                true
            }
          />
          <Show when={hasPresentation() && !initialIdentityPending()}>
            <ModelAccounts
              target={state.modelAccountsTarget}
              personLabel={
                view().ownProfile
                  ? userProfileDisplayName(
                      view().ownProfile!.id,
                      view().ownProfile!.displayName,
                      view().ownProfile!.githubIdentity?.login,
                    ) || t("profilePage.modelAccounts.currentPerson")
                  : null
              }
            />
            <GitHubConnections />
            <AttributionSection />
          </Show>
          <Show when={hasPresentation()}>
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
                      disabled={identityBusy() !== null}
                      onClick={() => context.gateway.connect()}
                    >
                      {t("profilePage.access.reconnect")}
                    </button>
                  }
                />
                <Show when={upgrade.read()}>
                  {(current) => (
                    <SettingsRow
                      title={t("profilePage.access.adminRequest")}
                      description={
                        current().phase === "available"
                          ? t("profilePage.access.adminRequestHint")
                          : scopeUpgradeText(current())
                      }
                      stackedOnNarrow
                      control={
                        <ScopeUpgradeActions
                          state={current()}
                          onRequest={() => context.scopeUpgrade.request()}
                          onRetry={() => context.scopeUpgrade.retry()}
                          onCancel={() => context.scopeUpgrade.cancel()}
                        />
                      }
                    />
                  )}
                </Show>
                <SettingsDisclosure quiet title={t("profilePage.access.details")}>
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
                </SettingsDisclosure>
              </SettingsSection>
            </div>
          </Show>
          <Show when={hasPresentation() && !initialIdentityPending()}>
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
