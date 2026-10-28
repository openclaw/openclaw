import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsSegmented,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { GitLabConnectionsState } from "./gitlab-connections-state.ts";
import { GitLabManagedIdentity } from "./gitlab-managed-identity-view.tsx";
import { GitLabManagedIdentityState } from "./gitlab-managed-identity.ts";
import { GitLabServerAuthorization } from "./gitlab-server-authorization.tsx";

registerEnglishCatalog(registerProfileEnglish);

/** User-bound GitLab identity for publication, issues, and comments. */
export function GitLabConnections(
  props: {
    onConnectReady?: (connect: (() => void) | null) => void;
    onAvailable?: (available: boolean) => void;
  } = {},
) {
  const context = useApplication();
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [purpose, setPurpose] = createSignal<"personal" | "system">("personal");
  const system = new GitLabManagedIdentityState();
  const agent = new GitLabManagedIdentityState();
  const systemProjection = projectOwner(system, (owner) => owner.view);
  const systemView = createMemo(() => systemProjection.read());
  const state = new GitLabConnectionsState(async () => {
    await Promise.all([system.verify(), agent.verify()]);
  });
  const projection = projectOwner(state, (owner) => owner.view);
  const view = createMemo(() => projection.read());
  onSettled(() => {
    props.onConnectReady?.(() => {
      setPurpose("personal");
      setSetupOpen(true);
    });
    const notifyAvailability = () => {
      props.onAvailable?.(state.view.eligible && state.view.status?.configured === true);
    };
    const unsubscribeAvailability = state.subscribe(notifyAvailability);
    notifyAvailability();
    const sync = (snapshot: typeof context.gateway.snapshot) => {
      state.sync(snapshot);
      const agentId = context.settingsAgentSelection.state.selectedId;
      system.sync(snapshot, agentId ? { scope: "system", agentId } : null);
      agent.sync(snapshot, agentId ? { scope: "agent", agentId } : null);
    };
    const unsubscribe = context.gateway.subscribe(sync);
    const refreshTargets = () => sync(context.gateway.snapshot);
    const subscriptions = [
      context.settingsAgentSelection.subscribe(refreshTargets),
      context.agents.subscribe(refreshTargets),
      context.runtimeConfig.subscribe(() => {
        refreshTargets();
        void system.verify();
        void agent.verify();
      }),
    ];
    sync(context.gateway.snapshot);
    return () => {
      props.onConnectReady?.(null);
      unsubscribeAvailability();
      unsubscribe();
      for (const stop of subscriptions) {
        stop();
      }
      system.dispose();
      agent.dispose();
      state.dispose();
    };
  });

  return (
    <Show when={view().eligible && (view().status?.configured || view().error)}>
      <div data-gitlab-connections="personal">
        <SettingsSection
          title="GitLab connections"
          description="Check your connected GitLab account for publishing, issues, and comments."
          actions={
            <Show when={view().status?.configured}>
              <button
                type="button"
                class="btn btn--sm"
                disabled={view().busy || view().loading}
                onClick={() => {
                  setPurpose("personal");
                  setSetupOpen(true);
                }}
              >
                Manage connections
              </button>
              <button
                type="button"
                class="btn btn--sm"
                disabled={view().busy}
                onClick={() => {
                  void state.loadStatus();
                  void system.verify();
                  void agent.verify();
                }}
              >
                Verify
              </button>
            </Show>
          }
        >
          <Show when={view().error}>
            <SettingsRow
              title="GitLab connection"
              description={view().error}
              role="alert"
              control={
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={view().busy}
                  onClick={() => void state.loadStatus()}
                >
                  Retry
                </button>
              }
            />
          </Show>
          <Show when={view().status?.configured}>
            <SettingsRow
              title={t("profilePage.gitConnections.gitlabServer")}
              description={view().status?.issuer}
            />
            <SettingsRow
              title="My GitLab"
              description={
                view().status?.connected && view().status?.account
                  ? `Your GitLab publications, issues, and comments use @${view().status!.account!.login}.`
                  : view().status?.verificationUnavailable
                    ? "Could not verify your GitLab account. Try Verify again."
                    : view().status?.reconnectRequired
                      ? "Reconnect your GitLab account to publish or work with issues and comments."
                      : "No GitLab account connected."
              }
              control={
                <>
                  <SettingsStatus
                    kind={
                      view().status?.connected
                        ? "ok"
                        : view().status?.reconnectRequired
                          ? "warn"
                          : "muted"
                    }
                    label={
                      view().status?.connected
                        ? "Connected"
                        : view().status?.verificationUnavailable
                          ? "Verification unavailable"
                          : view().status?.reconnectRequired
                            ? "Reconnect required"
                            : "Disconnected"
                    }
                  />
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={view().busy || view().loading}
                    onClick={() => {
                      setPurpose("personal");
                      setSetupOpen(true);
                    }}
                  >
                    {view().status?.connected ? "Change My GitLab" : "Connect My GitLab"}
                  </button>
                </>
              }
            />
            <Show when={view().status?.connected && view().status?.account}>
              <SettingsRow
                title="Verified GitLab account"
                description={view().status?.issuer}
                control={<SettingsValue value={`@${view().status!.account!.login}`} />}
              />
            </Show>
            <GitLabManagedIdentity
              identity={system}
              readView={systemView}
              scope="system"
              mode="account"
              title="System GitLab"
              description="Default account for agent commands and explicitly selected publication."
              setupOpen={setupOpen() && purpose() === "system"}
              onOpenSetup={() => {
                setPurpose("system");
                setSetupOpen(true);
              }}
              onCloseSetup={() => setSetupOpen(false)}
            />
            <GitLabManagedIdentity
              identity={agent}
              scope="agent"
              title="GitLab for this agent"
              description="Account used for this agent’s commands and explicitly selected publication."
              onViewAccount={() => {
                const agentId = context.settingsAgentSelection.state.selectedId;
                if (agentId) {
                  context.navigate("agents", {
                    pathname: pathForAgentPanel(agentId, "tools", context.basePath),
                  });
                }
              }}
            />
            <Show when={setupOpen()}>
              <SettingsRow
                title="Connect GitLab"
                control={
                  systemView().canAdmin ? (
                    <SettingsSegmented
                      value={purpose()}
                      ariaLabel="GitLab connection purpose"
                      options={[
                        { value: "personal", label: "For me" },
                        { value: "system", label: "For the system" },
                      ]}
                      onChange={setPurpose}
                    />
                  ) : (
                    <SettingsValue value="For me" />
                  )
                }
              />
            </Show>
            <GitLabManagedIdentity
              identity={system}
              readView={systemView}
              scope="system"
              mode="setup"
              title="System GitLab"
              description="Default account for agent commands and explicitly selected publication."
              setupOpen={setupOpen() && purpose() === "system"}
              onCloseSetup={() => setSetupOpen(false)}
            />
            <Show when={setupOpen() && purpose() === "personal"}>
              <GitLabServerAuthorization
                issuer={view().status?.issuer}
                disabled={view().busy || Boolean(view().pending)}
                title="GitLab authorization"
                description="Sign in through GitLab. You will return here to finish connecting automatically."
                onContinue={(serverUrl) => void state.start(serverUrl)}
              />
              <Show when={view().pending}>
                <SettingsRow
                  title="Continue in GitLab"
                  description="Open GitLab in a new tab and approve access for your account."
                  control={
                    <a
                      class="btn btn--sm"
                      href={view().pending!.authorizationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open GitLab sign-in
                    </a>
                  }
                />
                <SettingsRow
                  title="Finish connection"
                  description="After authorizing in GitLab, the returned Profile page completes your connection automatically. Refresh this page to see the connected account."
                />
              </Show>
              <Show when={view().status?.connected || view().pending}>
                <SettingsRow
                  title="Disconnect GitLab"
                  description="Removes this profile’s selected GitLab account."
                  control={
                    <button
                      type="button"
                      class="btn btn--sm"
                      disabled={view().busy}
                      onClick={() => {
                        void state.disconnect();
                      }}
                    >
                      Disconnect
                    </button>
                  }
                />
              </Show>
              <SettingsRow
                title="Only your selected connection changes."
                control={
                  <button type="button" class="btn btn--sm" onClick={() => setSetupOpen(false)}>
                    Close
                  </button>
                }
              />
            </Show>
          </Show>
        </SettingsSection>
      </div>
    </Show>
  );
}
