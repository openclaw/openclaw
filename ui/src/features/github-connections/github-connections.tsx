import { createMemo, createSignal, onSettled } from "solid-js";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerGitHubConnectionsEnglish } from "../../i18n/locales/en-github-connections.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { projectGateway, projectAgentSelection } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { createGitHubIdentityView } from "../../lib/reactive/domain-github-identity.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../../pages/config/settings-targets.ts";
import {
  GitHubConnectionError,
  GitHubConnectionSetup,
  GitHubDetails,
  GitHubHealth,
  GitHubUnloadedStatus,
} from "./github-identity-view.tsx";

function access(snapshot: ApplicationGatewaySnapshot) {
  const profileId = snapshot.phase === "connected" ? (snapshot.selfUser?.id ?? null) : null;
  // Access comes from the authenticated connection, never a status RPC error.
  const canRead =
    snapshot.phase === "connected" &&
    Boolean(snapshot.hello?.auth) &&
    hasOperatorReadAccess(snapshot.hello?.auth ?? null);
  return {
    profileId,
    canRead,
    canAdmin: canRead && hasOperatorAdminAccess(snapshot.hello?.auth ?? null),
  };
}

/** Profile credentials have their own read-scoped lifecycle, independent of users.self edits. */
export function GitHubConnections() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const selection = projectAgentSelection(context.settingsAgentSelection);
  const [purpose, setPurpose] = createSignal<"personal" | "system">("personal");
  const [setupOpen, setSetupOpen] = createSignal(false);
  let snapshot: ApplicationGatewaySnapshot | null = null;
  let clientRevision = 0;
  let canRead = false;
  let canAdmin = false;
  // Gateway snapshots may mutate in place; retain the previous profile transition fact.
  let observedProfileId: string | null = null;
  const authorizationSucceeded = () => setSetupOpen(false);
  const personal = createGitHubIdentityView({ authorizationSucceeded });
  const system = createGitHubIdentityView({
    authorizationSucceeded,
    runExternalMutation: (task, options) =>
      context.runtimeConfig.runExternalMutation(task, options),
  });

  const syncIdentities = () => {
    if (!snapshot) {
      return;
    }
    const common = {
      client: snapshot.client,
      connected: snapshot.phase === "connected" && snapshot.selfUser !== undefined,
      permissionsReady: snapshot.phase === "connected" && Boolean(snapshot.hello),
      clientRevision,
    };
    personal.sync({
      ...common,
      target: observedProfileId ? { kind: "personal", profileId: observedProfileId } : null,
      statusReadable: canRead && observedProfileId !== null,
      authorizable: canRead && observedProfileId !== null,
      configurable: false,
    });
    const agentId = context.settingsAgentSelection.state.selectedId;
    system.sync({
      ...common,
      target: agentId
        ? {
            kind: "shared",
            scope: "system",
            profileId: observedProfileId,
            agentId,
            config: currentConfigObject(context.runtimeConfig.state),
          }
        : null,
      statusReadable: canAdmin,
      authorizable: canAdmin,
      configurable: canAdmin,
    });
    personal.ensureVerified();
    system.ensureVerified();
  };
  const applySnapshot = (next: ApplicationGatewaySnapshot) => {
    const identityChanged =
      !snapshot ||
      snapshot.client !== next.client ||
      (next.phase === "connected" &&
        next.selfUser !== undefined &&
        observedProfileId !== (next.selfUser?.id ?? null));
    const changed =
      !snapshot ||
      snapshot.client !== next.client ||
      snapshot.phase !== next.phase ||
      snapshot.hello !== next.hello ||
      (snapshot.selfUser === undefined) !== (next.selfUser === undefined) ||
      (next.selfUser !== undefined && observedProfileId !== (next.selfUser?.id ?? null));
    snapshot = next;
    observedProfileId =
      (next.phase === "connected" && next.selfUser !== undefined) || identityChanged
        ? (next.selfUser?.id ?? null)
        : observedProfileId;
    // Access comes from the authenticated connection, never an error from users.github.status.
    const previousCanRead = canRead;
    const previousCanAdmin = canAdmin;
    if (next.phase === "connected" || identityChanged) {
      canRead = Boolean(next.hello?.auth) && hasOperatorReadAccess(next.hello?.auth ?? null);
      canAdmin = canRead && hasOperatorAdminAccess(next.hello?.auth ?? null);
    }
    if (changed) {
      clientRevision += 1;
    }
    const readAccessLost = previousCanRead && !canRead;
    const adminAccessLost = previousCanAdmin && !canAdmin;
    if (identityChanged || readAccessLost || adminAccessLost) {
      setSetupOpen(false);
      setPurpose(observedProfileId ? "personal" : "system");
    }
    syncIdentities();
    if (canAdmin) {
      void context.runtimeConfig.ensureLoaded();
    }
  };
  onSettled(() => {
    const subscriptions = [
      context.gateway.subscribe(applySnapshot),
      context.agents.subscribe(syncIdentities),
      context.settingsAgentSelection.subscribe(syncIdentities),
      context.runtimeConfig.subscribe(syncIdentities),
    ];
    applySnapshot(context.gateway.snapshot);
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  });

  const view = createMemo(() => {
    const current = gateway.read().snapshot;
    const personalState = personal.read();
    const systemState = system.read();
    const account = personalState.personal;
    const agentId = selection.read().state.selectedId;
    const agent = agents.read().agentsList?.agents?.find((entry) => entry.id === agentId);
    const connected = account?.state === "connected";
    const reconnectRequired =
      account?.state === "unavailable" ||
      account?.refreshState === "expired" ||
      account?.refreshState === "failed";
    return {
      account,
      agentId,
      agent,
      connected,
      reconnectRequired,
      profileId: observedProfileId,
      canRead,
      canAdmin,
      systemIdentity: systemState.status?.selected.identity ?? personalState.system,
      effective: systemState.status?.effective ?? null,
      locked:
        current.phase !== "connected" ||
        current.selfUser === undefined ||
        personalState.loading ||
        systemState.loading ||
        personalState.authorizationActive ||
        systemState.authorizationActive ||
        personalState.busy ||
        systemState.busy,
      showSetup:
        setupOpen() || personalState.authorizationActive || systemState.authorizationActive,
      personalLabel: !observedProfileId
        ? t("githubConnections.signInRequired")
        : reconnectRequired
          ? t("githubConnections.reconnectRequired")
          : connected
            ? t("githubConnections.connected")
            : t("githubConnections.disconnected"),
    };
  });
  const personalView = personal.read;
  const systemView = system.read;
  const active = () => (purpose() === "personal" ? personal : system);
  const openSetup = (next: "personal" | "system") => {
    const currentAccess = access(context.gateway.snapshot);
    if (
      view().locked ||
      (next === "personal"
        ? !currentAccess.profileId || !currentAccess.canRead
        : !currentAccess.canAdmin)
    ) {
      return;
    }
    setPurpose(next);
    setSetupOpen(true);
  };
  const verify = () => {
    void personal.verify();
    void system.verify();
  };
  return (
    <openclaw-github-connections>
      <div id={PROFILE_SETTINGS_TARGET_IDS.githubConnections}>
        <SettingsSection
          title={t("githubConnections.title")}
          description={t("githubConnections.description")}
          actions={
            view().canRead && (view().profileId || view().canAdmin) ? (
              <>
                <button
                  class="btn btn--sm"
                  disabled={view().locked || (!view().profileId && !systemView().status)}
                  onClick={() => openSetup(view().profileId ? "personal" : "system")}
                >
                  {t("githubConnections.manage")}
                </button>
                <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                  {t("agentTools.githubVerify")}
                </button>
              </>
            ) : undefined
          }
        >
          <div data-github-connection="personal">
            <SettingsRow
              title={t("githubConnections.mine")}
              description={
                view().profileId ? (
                  <>
                    {view().account?.account ? `@${view().account?.account?.login} · ` : ""}
                    {t("githubConnections.personalDescription")}
                  </>
                ) : (
                  t("githubConnections.unboundDescription")
                )
              }
              control={
                <>
                  {view().profileId && !view().account ? (
                    <GitHubUnloadedStatus request={personalView()} />
                  ) : (
                    <SettingsStatus
                      kind={view().reconnectRequired ? "warn" : view().connected ? "ok" : "muted"}
                      label={view().personalLabel}
                    />
                  )}
                  {view().profileId && view().canRead && view().account ? (
                    <button
                      class="btn btn--sm"
                      disabled={view().locked}
                      onClick={() => openSetup("personal")}
                    >
                      {t(
                        view().connected
                          ? "githubConnections.changeMine"
                          : "githubConnections.connectMine",
                      )}
                    </button>
                  ) : undefined}
                </>
              }
            />
          </div>
          <div data-github-connection="system">
            <SettingsRow
              title={t("githubConnections.system")}
              description={
                <>
                  {view().systemIdentity?.account
                    ? `@${view().systemIdentity?.account?.login} · `
                    : ""}
                  {t("githubConnections.systemDescription")}
                </>
              }
              control={
                <>
                  <GitHubHealth
                    identity={view().systemIdentity}
                    request={view().canAdmin ? systemView() : personalView()}
                  />
                  {view().canAdmin ? (
                    <button
                      class="btn btn--sm"
                      disabled={view().locked || !systemView().status}
                      onClick={() => openSetup("system")}
                    >
                      {t("githubConnections.changeSystem")}
                    </button>
                  ) : (
                    <SettingsValue value={t("githubConnections.adminManaged")} />
                  )}
                </>
              }
            />
          </div>
          {view().canAdmin && view().agentId ? (
            <div data-github-connection="agent">
              <SettingsRow
                title={t("githubConnections.agentFor", {
                  agent: view().agent?.identity?.name ?? view().agent?.name ?? view().agentId!,
                })}
                description={
                  <>
                    {view().effective?.account ? `@${view().effective?.account?.login} · ` : ""}
                    {view().effective
                      ? t(
                          view().effective?.source === "agent-override"
                            ? "githubConnections.agentOverride"
                            : "githubConnections.system",
                        )
                      : ""}
                    <br />
                    {t("githubConnections.agentDescription")}
                  </>
                }
                control={
                  <>
                    <GitHubHealth identity={view().effective} request={systemView()} />
                    <button
                      class="btn btn--sm"
                      onClick={() =>
                        context.navigate("agents", {
                          pathname: pathForAgentPanel(view().agentId!, "tools", context.basePath),
                        })
                      }
                    >
                      {t("githubConnections.viewAgent")}
                    </button>
                  </>
                }
              />
            </div>
          ) : undefined}
          <GitHubConnectionError
            error={personalView().error ?? systemView().error}
            completion={personalView().completion}
            secondaryCompletion={systemView().completion}
            control={
              <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                {t("common.retry")}
              </button>
            }
          />
          {view().showSetup ? (
            <div class="settings-subrows" data-github-setup>
              <SettingsRow
                title={t("githubConnections.purpose")}
                control={
                  view().profileId && view().canAdmin && systemView().status ? (
                    <SettingsSegmented
                      value={purpose()}
                      options={[
                        { value: "personal", label: t("githubConnections.forMe") },
                        { value: "system", label: t("githubConnections.forSystem") },
                      ]}
                      disabled={view().locked}
                      ariaLabel={t("githubConnections.purpose")}
                      onChange={openSetup}
                    />
                  ) : (
                    <SettingsValue
                      value={t(
                        purpose() === "personal"
                          ? "githubConnections.forMe"
                          : "githubConnections.forSystem",
                      )}
                    />
                  )
                }
              />
              <GitHubConnectionSetup identity={active()} />
              {!view().locked ? (
                <SettingsRow
                  title={t("githubConnections.purposeHint")}
                  control={
                    <button
                      class="btn btn--sm"
                      onClick={() => {
                        setSetupOpen(false);
                        active().hidePatFallback();
                      }}
                    >
                      {t("common.close")}
                    </button>
                  }
                />
              ) : undefined}
            </div>
          ) : undefined}
          <details class="settings-row settings-row--stacked">
            <summary class="settings-row__title">{t("githubConnections.usage")}</summary>
            <div class="settings-row__desc">{t("githubConnections.usageDescription")}</div>
            <GitHubDetails identity={view().systemIdentity} />
          </details>
          {view().canAdmin && systemView().status?.selected.configured ? (
            <SettingsRow
              title={t("agentTools.githubUseNativeNewRuns")}
              description={t("agentTools.githubSystemMutationHint")}
              control={
                <button
                  class="btn btn--sm"
                  disabled={view().locked}
                  onClick={() => void system.inherit()}
                >
                  {t("agentTools.githubUseNativeNewRuns")}
                </button>
              }
            />
          ) : undefined}
        </SettingsSection>
        {view().profileId &&
        view().canRead &&
        view().account &&
        view().account?.state !== "disconnected" ? (
          <SettingsSection danger>
            <SettingsRow
              title={t("githubConnections.disconnectMine")}
              description={t("githubConnections.disconnectDescription")}
              control={
                <button
                  class="btn btn--sm"
                  disabled={view().locked}
                  onClick={() => void personal.disconnect()}
                >
                  {t("githubConnections.disconnectMine")}
                </button>
              }
            />
          </SettingsSection>
        ) : undefined}
      </div>
    </openclaw-github-connections>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-github-connections": HTMLAttributes<HTMLElement>;
    }
  }
}
registerGitHubConnectionsEnglish();
