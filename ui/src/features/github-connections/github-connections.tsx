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
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../../pages/config/settings-targets.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import {
  GitHubConnectionError,
  GitHubConnectionSetup,
  GitHubDetails,
  GitHubHealth,
  GitHubUnloadedStatus,
} from "./github-identity-view.tsx";

/** Profile credentials have their own read-scoped lifecycle, independent of users.self edits. */
function GitHubConnectionsContent() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0);
  const [purpose, setPurpose] = createSignal<"personal" | "system">("personal");
  const [setupOpen, setSetupOpen] = createSignal(false);
  let snapshot: ApplicationGatewaySnapshot | null = null;
  let clientRevision = 0;
  let canRead = false;
  let canAdmin = false;
  let profileId: string | null = null;
  const requestUpdate = () => setRevision((value) => value + 1);
  const authorizationSucceeded = () => setSetupOpen(false);
  const personal = new GitHubIdentityController({ requestUpdate, authorizationSucceeded });
  const system = new GitHubIdentityController({
    requestUpdate,
    authorizationSucceeded,
    runExternalMutation: (task, options) =>
      context.runtimeConfig.runExternalMutation(task, options),
  });

  const syncControllers = () => {
    if (!snapshot) {
      return;
    }
    const common = {
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      clientRevision,
    };
    personal.sync({
      ...common,
      target: profileId ? { kind: "personal", profileId } : null,
      statusReadable: canRead && profileId !== null,
      authorizable: canRead && profileId !== null,
      configurable: false,
    });
    const agentId = context.settingsAgentSelection.state.selectedId;
    system.sync({
      ...common,
      target: agentId
        ? {
            kind: "shared",
            scope: "system",
            agentId,
            config: currentConfigObject(context.runtimeConfig.state),
          }
        : null,
      statusReadable: canAdmin,
      authorizable: canAdmin,
      configurable: canAdmin,
    });
    if (personal.statusReadable && !personal.personal && !personal.loading && !personal.error) {
      void personal.verify();
    }
    if (agentId && canAdmin && !system.status && !system.loading && !system.error) {
      void system.verify();
    }
    requestUpdate();
  };
  const applySnapshot = (next: ApplicationGatewaySnapshot) => {
    const changed =
      !snapshot ||
      snapshot.client !== next.client ||
      snapshot.phase !== next.phase ||
      snapshot.hello !== next.hello ||
      profileId !== (next.selfUser?.id ?? null);
    snapshot = next;
    profileId = next.phase === "connected" ? (next.selfUser?.id ?? null) : null;
    // Access comes from the authenticated connection, never an error from users.github.status.
    canRead =
      next.phase === "connected" &&
      Boolean(next.hello?.auth) &&
      hasOperatorReadAccess(next.hello?.auth ?? null);
    canAdmin = canRead && hasOperatorAdminAccess(next.hello?.auth ?? null);
    if (changed) {
      clientRevision += 1;
      setSetupOpen(false);
      setPurpose(profileId ? "personal" : "system");
    }
    syncControllers();
    if (canAdmin) {
      void context.runtimeConfig.ensureLoaded();
    }
  };
  onSettled(() => {
    const subscriptions = [
      context.gateway.subscribe(applySnapshot),
      context.agents.subscribe(syncControllers),
      context.settingsAgentSelection.subscribe(syncControllers),
      context.runtimeConfig.subscribe(syncControllers),
    ];
    applySnapshot(context.gateway.snapshot);
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      personal.dispose();
      system.dispose();
    };
  });

  const view = createMemo(() => {
    revision();
    const account = personal.personal;
    const agentId = context.settingsAgentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents?.find((entry) => entry.id === agentId);
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
      profileId,
      canRead,
      canAdmin,
      systemIdentity: system.status?.selected.identity ?? personal.system,
      effective: system.status?.effective ?? null,
      locked:
        personal.loading ||
        system.loading ||
        personal.authorizationActive ||
        system.authorizationActive ||
        personal.busy ||
        system.busy,
      showSetup: setupOpen() || personal.authorizationActive || system.authorizationActive,
      personalLabel: !profileId
        ? t("githubConnections.signInRequired")
        : reconnectRequired
          ? t("githubConnections.reconnectRequired")
          : connected
            ? t("githubConnections.connected")
            : t("githubConnections.disconnected"),
    };
  });
  const personalView = () => {
    revision();
    return personal;
  };
  const systemView = () => {
    revision();
    return system;
  };
  const active = () => {
    revision();
    return purpose() === "personal" ? personal : system;
  };
  const openSetup = (next: "personal" | "system") => {
    if (view().locked || (next === "personal" ? !profileId || !canRead : !canAdmin)) {
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
                onClick={() => openSetup(profileId ? "personal" : "system")}
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
                  request={{
                    loading: systemView().loading || personalView().loading,
                    error: systemView().error ?? personalView().error,
                  }}
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
            <GitHubConnectionSetup controller={active()} />
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
  );
}

defineSolidBridge("openclaw-github-connections", () => <GitHubConnectionsContent />, {
  properties: {},
});
registerGitHubEnglish();
