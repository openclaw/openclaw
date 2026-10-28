import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  isPending,
  latest,
  Loading,
  onSettled,
  refresh,
  Show,
} from "solid-js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/index.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ScopeUpgradeOwner } from "../../app/device-scope-upgrade-owner.runtime.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { ScopeUpgradeActions, scopeUpgradeText } from "../../components/scope-upgrade-actions.tsx";
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
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { GitHubConnections } from "../../features/github-connections/github-connections.tsx";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import "../../components/solid/viewer-facepile.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import "../../styles/profile.css";
import { uploadsEnabled } from "../../lib/uploads.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";
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
        state.identityError = formatUiError(error, t("profilePage.identity.profileUnavailable"));
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
                description={t("profilePage.identity.description")}
              >
                <Show when={!canEditIdentity() && view().identityReady}>
                  <SettingsRow title={t("profilePage.identity.writeRequired")} />
                </Show>
                <SettingsRow
                  title={t("profilePage.identity.avatar")}
                  description={t("profilePage.identity.avatarDescription")}
                  control={
                    <span class="identity-avatar-control">
                      <openclaw-viewer-avatar
                        prop:user={{
                          id: profile().id,
                          name: profile().displayName ?? undefined,
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
                    description={t("profilePage.identity.linkedEmailsDescription")}
                    control={
                      profile().emails.length ? (
                        <SettingsValue value={profile().emails.join(", ")} />
                      ) : undefined
                    }
                  />
                </Show>
                <SettingsRow
                  title={t("profilePage.identity.githubAccount")}
                  description={
                    isOwnerProfile()
                      ? t("profilePage.identity.ownerGithubDescription")
                      : profile().githubIdentity
                        ? t("profilePage.identity.githubAccountDescription")
                        : t("profilePage.identity.githubUnavailableDescription")
                  }
                  control={
                    <Show
                      when={profile().githubIdentity}
                      fallback={
                        <SettingsStatus
                          kind="muted"
                          label={t("profilePage.identity.githubUnavailable")}
                        />
                      }
                    >
                      {(identity) => (
                        <>
                          <a
                            class="settings-account"
                            href={identity().profileUrl}
                            target={EXTERNAL_LINK_TARGET}
                            rel={buildExternalLinkRel()}
                          >
                            <img
                              class="settings-account__avatar"
                              src={identity().avatarUrl}
                              alt=""
                            />
                            <span class="settings-row__value settings-row__value--mono">
                              @{identity().login}
                            </span>
                          </a>
                          <SettingsStatus
                            kind="ok"
                            label={t("profilePage.identity.githubVerified")}
                          />
                        </>
                      )}
                    </Show>
                  }
                />
                <SettingsToggleRow
                  title={t("profilePage.identity.gitCoauthor")}
                  description={
                    // Publication selects its host independently of the displayed primary account.
                    isOwnerProfile()
                      ? t("profilePage.identity.ownerGitCoauthorDescription")
                      : t("profilePage.identity.gitCoauthorDescription")
                  }
                  checked={!isOwnerProfile() && presentation().gitCoauthorEnabled()}
                  disabled={
                    !canEditIdentity() ||
                    (busy() !== null && busy() !== "git-coauthor") ||
                    isOwnerProfile()
                  }
                  saving={busy() === "git-coauthor"}
                  onChange={(enabled) => void saveIdentity({ kind: "git-coauthor", enabled })}
                />
                <SettingsToggleRow
                  title={t("profilePage.identity.prAttribution")}
                  description={
                    <>
                      {t("profilePage.identity.prAttributionDescription")}
                      <br />
                      <a
                        href="https://openclaw.ai"
                        target={EXTERNAL_LINK_TARGET}
                        rel={buildExternalLinkRel()}
                      >
                        {t("profilePage.identity.prAttributionLink")}
                      </a>
                    </>
                  }
                  checked={presentation().prAttributionEnabled()}
                  disabled={!canEditIdentity() || busy() !== null}
                  onChange={(enabled) => void saveIdentity({ kind: "pr-attribution", enabled })}
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
              disabled={!view().identityReady || view().identityLoading || identityBusy() !== null}
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
          <PersonalInstructions
            hidden={
              !hasPresentation() ||
              view().context.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities !==
                true
            }
          />
          <Show when={hasPresentation()}>
            <ModelAccounts
              target={state.modelAccountsTarget}
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
