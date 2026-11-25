import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { SettingsDetailsRow } from "../../components/solid/settings-disclosure.tsx";
import { SettingsSectionHelp } from "../../components/solid/settings-section-help.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerGitHubConnectionsEnglish } from "../../i18n/locales/en-github-connections.ts";
import { listSelectableAgents, resolveAgentConfig } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import {
  createGitHubIdentityView,
  type GitHubIdentityView,
} from "../../lib/reactive/domain-github-identity.ts";
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

type SetupKey = "personal" | "system" | `agent:${string}`;
type AgentRowAgent = { id: string; name?: string; identity?: { name?: string } };

/** Status, who the connection acts as, and a short use: read at a glance at every width. */
function meta(status: SolidJSX.Element, handle: string | undefined, use: string | undefined) {
  return (
    <span class="settings-row__meta">
      {status}
      {handle ? <span class="github-connection__login">@{handle}</span> : undefined}
      {use ? <span>{use}</span> : undefined}
    </span>
  );
}

const CREDENTIAL_KIND_LABEL = {
  native: "agentTools.githubKindNative",
  "managed-pat": "agentTools.githubKindPat",
  "managed-oauth": "agentTools.githubKindOAuth",
  "app-installation": "agentTools.githubKindAppInstallation",
} as const;

/**
 * One agent's GitHub account. The row owns an agent-scoped identity, so giving the agent
 * its own account, changing it, or returning it to the shared account changes only this agent.
 */
function AgentGitHubRow(props: {
  agent: AgentRowAgent;
  register: (agentId: string, identity: GitHubIdentityView) => () => void;
  setupOpen: boolean;
  locked: boolean;
  onOpenSetup: () => void;
  onCloseSetup: () => void;
}) {
  const context = useApplication();
  const identity = createGitHubIdentityView({
    authorizationSucceeded: () => props.onCloseSetup(),
    runExternalMutation: (task, options) =>
      context.runtimeConfig.runExternalMutation(task, options),
  });
  onSettled(() => props.register(props.agent.id, identity));
  const view = () => identity.read();
  const name = () => props.agent.identity?.name ?? props.agent.name ?? props.agent.id;
  const effective = () => view().status?.effective ?? null;
  const ownAccount = () => view().status?.selected.configured === true;
  const rowLocked = () =>
    props.locked || !view().status || view().loading || view().busy || view().authorizationActive;
  const use = () => {
    if (!view().status) {
      return undefined;
    }
    const identityFacts = effective();
    return ownAccount()
      ? identityFacts
        ? t("githubConnections.ownAccountKind", {
            kind: t(CREDENTIAL_KIND_LABEL[identityFacts.credentialKind]),
          })
        : t("githubConnections.ownAccount")
      : t("githubConnections.usesShared");
  };
  const closeSetup = () => {
    props.onCloseSetup();
    identity.hidePatFallback();
  };
  return (
    <div data-github-connection="agent" data-agent-id={props.agent.id}>
      <SettingsRow
        title={name()}
        description={meta(
          <GitHubHealth identity={effective()} request={view()} />,
          effective()?.account?.login,
          use(),
        )}
        control={
          <Show
            when={ownAccount()}
            fallback={
              <button
                class="btn btn--sm"
                disabled={rowLocked()}
                aria-label={t("githubConnections.giveOwn", { agent: name() })}
                onClick={() => props.onOpenSetup()}
              >
                {t("githubConnections.giveOwnShort")}
              </button>
            }
          >
            <button
              class="btn btn--sm"
              disabled={rowLocked()}
              aria-label={t("githubConnections.changeAgent", { agent: name() })}
              onClick={() => props.onOpenSetup()}
            >
              {t("githubConnections.changeShort")}
            </button>
            <button
              class="btn btn--sm"
              disabled={rowLocked()}
              aria-label={t("githubConnections.useSharedFor", { agent: name() })}
              onClick={() => {
                props.onCloseSetup();
                void identity.inherit();
              }}
            >
              {t("agentTools.githubUseSystemNewRuns")}
            </button>
          </Show>
        }
      />
      <Show when={props.setupOpen || view().authorizationActive}>
        <div class="settings-subrows" data-github-setup>
          <SettingsRow
            title={t("githubConnections.agentSetupTitle", { agent: name() })}
            description={t("githubConnections.agentSetupHint", { agent: name() })}
          />
          <GitHubConnectionSetup
            identity={identity}
            saveLabel={t("githubConnections.saveForAgent", { agent: name() })}
          />
          <Show when={!view().busy && !view().authorizationActive}>
            <div class="settings-row settings-row--actions">
              <div class="settings-row__control">
                <button class="btn btn--sm" onClick={closeSetup}>
                  {t("common.close")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </Show>
      <GitHubConnectionError error={view().error} completion={view().completion} />
    </div>
  );
}

/** Profile credentials have their own read-scoped lifecycle, independent of users.self edits. */
export function GitHubConnections() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const [setupKey, setSetupKey] = createSignal<SetupKey | null>(null);
  let snapshot: ApplicationGatewaySnapshot | null = null;
  let clientRevision = 0;
  let canRead = false;
  let canAdmin = false;
  // Gateway snapshots may mutate in place; retain the previous profile transition fact.
  let observedProfileId: string | null = null;
  const agentIdentities = new Map<string, GitHubIdentityView>();
  const authorizationSucceeded = () => setSetupKey(null);
  const personal = createGitHubIdentityView({ authorizationSucceeded });
  const system = createGitHubIdentityView({
    authorizationSucceeded,
    runExternalMutation: (task, options) =>
      context.runtimeConfig.runExternalMutation(task, options),
  });

  const common = (current: ApplicationGatewaySnapshot) => ({
    client: current.client,
    connected: current.phase === "connected" && current.selfUser !== undefined,
    permissionsReady: current.phase === "connected" && Boolean(current.hello),
    clientRevision,
  });
  const syncAgentIdentity = (agentId: string, identity: GitHubIdentityView) => {
    if (!snapshot) {
      return;
    }
    identity.sync({
      ...common(snapshot),
      target: {
        kind: "shared",
        scope: "agent",
        profileId: observedProfileId,
        agentId,
        config: currentConfigObject(context.runtimeConfig.state),
      },
      statusReadable: canAdmin,
      authorizable: canAdmin,
      configurable: canAdmin,
    });
    identity.ensureVerified();
  };
  const syncIdentities = () => {
    if (!snapshot) {
      return;
    }
    personal.sync({
      ...common(snapshot),
      target: observedProfileId ? { kind: "personal", profileId: observedProfileId } : null,
      statusReadable: canRead && observedProfileId !== null,
      authorizable: canRead && observedProfileId !== null,
      configurable: false,
    });
    // The shared account's status is read through an agent; any agent reports the same account.
    const agentId = context.settingsAgentSelection.state.selectedId;
    system.sync({
      ...common(snapshot),
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
    agentIdentities.forEach((identity, id) => syncAgentIdentity(id, identity));
  };
  const registerAgent = (agentId: string, identity: GitHubIdentityView) => {
    agentIdentities.set(agentId, identity);
    syncAgentIdentity(agentId, identity);
    return () => {
      if (agentIdentities.get(agentId) === identity) {
        agentIdentities.delete(agentId);
      }
    };
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
      setSetupKey(null);
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
    const agentList = listSelectableAgents(agents.read().agentsList?.agents ?? []);
    const config = currentConfigObject(runtimeConfig.read().state);
    const connected = account?.state === "connected";
    const reconnectRequired =
      account?.state === "unavailable" ||
      account?.refreshState === "expired" ||
      account?.refreshState === "failed";
    return {
      account,
      agentList,
      // Config owns which agents carry their own account; without it the count is unknown.
      sharedAgentCount: config
        ? agentList.filter((agent) => !resolveAgentConfig(config, agent.id).entry?.tools?.github)
            .length
        : null,
      connected,
      reconnectRequired,
      profileId: observedProfileId,
      canRead,
      canAdmin,
      systemIdentity: systemState.status?.selected.identity ?? personalState.system,
      locked:
        current.phase !== "connected" ||
        current.selfUser === undefined ||
        personalState.loading ||
        systemState.loading ||
        personalState.authorizationActive ||
        systemState.authorizationActive ||
        personalState.busy ||
        systemState.busy,
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
  const openSetup = (next: SetupKey) => {
    const currentAccess = access(context.gateway.snapshot);
    if (
      view().locked ||
      (next === "personal"
        ? !currentAccess.profileId || !currentAccess.canRead
        : !currentAccess.canAdmin)
    ) {
      return;
    }
    if (setupKey() === "personal") {
      personal.hidePatFallback();
    } else if (setupKey() === "system") {
      system.hidePatFallback();
    }
    setSetupKey(next);
  };
  const closeSetup = (key: SetupKey) => {
    if (setupKey() === key) {
      setSetupKey(null);
    }
  };
  const verify = () => {
    void personal.verify();
    void system.verify();
    agentIdentities.forEach((identity) => void identity.verify());
  };
  /** The flow opens under the connection it changes, so nothing has to name its purpose. */
  const setupFor = (target: "personal" | "system") => {
    const identity = target === "personal" ? personal : system;
    return setupKey() === target || identity.read().authorizationActive ? (
      <div class="settings-subrows" data-github-setup>
        <GitHubConnectionSetup identity={identity} />
        {!view().locked ? (
          <>
            {target === "personal" &&
            view().account &&
            view().account?.state !== "disconnected" &&
            view().canRead ? (
              <SettingsRow
                title={t("githubConnections.disconnectMine")}
                description={t("githubConnections.disconnectDescription")}
                control={
                  <button
                    class="btn btn--sm danger"
                    onClick={() => {
                      closeSetup("personal");
                      void personal.disconnect();
                    }}
                  >
                    {t("githubConnections.disconnect")}
                  </button>
                }
              />
            ) : undefined}
            <div class="settings-row">
              <span class="settings-row__desc">
                {t(
                  target === "personal"
                    ? "githubConnections.personalSetupHint"
                    : "githubConnections.systemSetupHint",
                )}
              </span>
              <div class="settings-row__control">
                {target === "system" &&
                view().canAdmin &&
                systemView().status?.selected.configured ? (
                  <button class="btn btn--sm" onClick={() => void system.inherit()}>
                    {t("agentTools.githubUseNativeNewRuns")}
                  </button>
                ) : undefined}
                <button
                  class="btn btn--sm"
                  onClick={() => {
                    closeSetup(target);
                    identity.hidePatFallback();
                  }}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          </>
        ) : undefined}
      </div>
    ) : undefined;
  };
  const changeSystemLabel = () => {
    const count = view().sharedAgentCount;
    return count === null
      ? t("githubConnections.changeShort")
      : count === 1
        ? t("githubConnections.changeSystemForOne")
        : t("githubConnections.changeSystemForMany", { count: String(count) });
  };
  return (
    <openclaw-github-connections>
      <div id={PROFILE_SETTINGS_TARGET_IDS.githubConnections} class="settings-stack">
        <SettingsSection
          title={t("githubConnections.title")}
          description={t("githubConnections.description")}
          actions={
            <>
              {view().canRead && (view().profileId || view().canAdmin) ? (
                <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                  {t("agentTools.githubVerify")}
                </button>
              ) : undefined}
              <SettingsSectionHelp
                id="settings-profile-github-connections-help"
                section={t("githubConnections.title")}
              >
                <p>{t("githubConnections.descriptionMore")}</p>
                <p>
                  <strong>{t("githubConnections.mine")}</strong>{" "}
                  {t(
                    view().profileId
                      ? "githubConnections.personalDescription"
                      : "githubConnections.unboundDescription",
                  )}
                </p>
                <p>
                  <strong>{t("githubConnections.system")}</strong>{" "}
                  {t("githubConnections.systemDescription")}
                </p>
                <p>
                  <strong>{t("githubConnections.agentsTitle")}</strong>{" "}
                  {t("githubConnections.agentsHelp")}
                </p>
                <p>
                  <strong>{t("githubConnections.usage")}</strong>{" "}
                  {t("githubConnections.usageDescription")}
                </p>
              </SettingsSectionHelp>
            </>
          }
        >
          <div data-github-connection="personal">
            <SettingsRow
              title={t("githubConnections.mine")}
              description={meta(
                view().profileId && !view().account ? (
                  <GitHubUnloadedStatus request={personalView()} />
                ) : (
                  <SettingsStatus
                    kind={view().reconnectRequired ? "warn" : view().connected ? "ok" : "muted"}
                    label={view().personalLabel}
                  />
                ),
                view().account?.account?.login,
                view().profileId ? t("githubConnections.personalUse") : undefined,
              )}
              control={
                view().profileId && view().canRead ? (
                  <button
                    class="btn btn--sm"
                    disabled={view().locked}
                    aria-label={t(
                      !view().account
                        ? "githubConnections.manage"
                        : view().connected
                          ? "githubConnections.changeMine"
                          : "githubConnections.connectMine",
                    )}
                    onClick={() => openSetup("personal")}
                  >
                    {/* An unknown status can't promise either "connect" or "change". */}
                    {t(
                      !view().account
                        ? "githubConnections.manageShort"
                        : view().connected
                          ? "githubConnections.changeShort"
                          : "githubConnections.connectShort",
                    )}
                  </button>
                ) : undefined
              }
            />
            {setupFor("personal")}
          </div>
          <GitHubConnectionError
            error={personalView().error}
            completion={personalView().completion}
            control={
              <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                {t("common.retry")}
              </button>
            }
          />
        </SettingsSection>
        <SettingsSection
          title={t("githubConnections.agentsTitle")}
          description={t("githubConnections.agentsDescription")}
        >
          <div data-github-connection="system">
            <SettingsDetailsRow
              detailsLabel={t("githubConnections.details")}
              hasDetails={Boolean(view().systemIdentity)}
              title={t("githubConnections.system")}
              description={meta(
                <GitHubHealth
                  identity={view().systemIdentity}
                  request={view().canAdmin ? systemView() : personalView()}
                />,
                view().systemIdentity?.account?.login,
                t("githubConnections.systemUse"),
              )}
              control={
                view().canAdmin ? (
                  <button
                    class="btn btn--sm"
                    disabled={view().locked || !systemView().status}
                    aria-label={t("githubConnections.changeSystem")}
                    onClick={() => openSetup("system")}
                  >
                    {changeSystemLabel()}
                  </button>
                ) : (
                  <SettingsValue value={t("githubConnections.adminManaged")} />
                )
              }
            >
              <GitHubDetails identity={view().systemIdentity} />
            </SettingsDetailsRow>
            {setupFor("system")}
          </div>
          <GitHubConnectionError
            error={systemView().error}
            completion={systemView().completion}
            control={
              <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                {t("common.retry")}
              </button>
            }
          />
          <Show when={view().canAdmin}>
            <For each={view().agentList} keyed={(agent) => agent.id}>
              {(agent) => (
                <AgentGitHubRow
                  agent={agent()}
                  register={registerAgent}
                  locked={view().locked}
                  setupOpen={setupKey() === `agent:${agent().id}`}
                  onOpenSetup={() => openSetup(`agent:${agent().id}`)}
                  onCloseSetup={() => closeSetup(`agent:${agent().id}`)}
                />
              )}
            </For>
          </Show>
        </SettingsSection>
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
