import { render as renderSolid, type JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { LitContent } from "../lit/solid-bridge.ts";
import {
  renderCloudChoiceMenuItems,
  renderCloudProfileMenuItems,
  renderSessionMenuItem,
} from "../pages/new-session/cloud-target.ts";
import type { DevicePlacementOption } from "../pages/new-session/device-placement.ts";
import type { DraftCloudProfile } from "../pages/new-session/discovery.ts";
import { DraftCloudMachineState } from "../pages/new-session/draft-cloud-machine-state.ts";
import "../styles/new-session.css";
import { icons } from "./icons.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { compareCloudProfiles } from "./provider-icon.ts";

registerNewSessionSetupEnglish();

type Catalog = {
  profiles: readonly DraftCloudProfile[];
  devices: readonly DevicePlacementOption[];
};

type Options = {
  mode: "dispatch" | "move" | "restart";
  sessionLabel: string;
  activeRun: boolean;
  gatewayDisabledReason?: string;
  deviceDisabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  loadCatalog: () => Promise<Catalog>;
};

let active = false;

function targetKey(target: SessionMoveTarget | null): string {
  if (!target) {
    return "";
  }
  switch (target.kind) {
    case "gateway":
      return "gateway";
    case "profile":
      return `profile:${target.profileId}`;
    default:
      return `device:${target.deviceId}`;
  }
}

export function showSessionPlacementTargetDialog(
  options: Options,
): Promise<SessionMoveTarget | null> {
  if (active) {
    return Promise.resolve(null);
  }
  active = true;
  return withPromiseModalHost<SessionMoveTarget | null, JSX.Element>(
    undefined,
    (modal) => {
      const finish = (result: SessionMoveTarget | null) => {
        modal.finish(result);
        active = false;
      };
      function Dialog() {
        const [loading, setLoading] = createSignal(true);
        const [loadError, setLoadError] = createSignal<string | null>(null);
        const [catalog, setCatalog] = createSignal<Catalog>({ profiles: [], devices: [] });
        const [selected, select] = createSignal<SessionMoveTarget | null>(
          options.mode === "move" ? { kind: "gateway" } : null,
        );
        const [machineRevision, setMachineRevision] = createSignal(0);
        const cloudMachines = new DraftCloudMachineState();
        const selectedKey = createMemo(() => targetKey(selected()));
        const profiles = createMemo(() => catalog().profiles.toSorted(compareCloudProfiles));
        const title = () => t(`sessionsView.${options.mode}SessionTitle`);
        const dispatch = options.mode === "dispatch";

        const submit = (event: Event) => {
          event.preventDefault();
          const target = selected();
          if (!target) {
            return;
          }
          if (target.kind !== "profile") {
            finish(target);
            return;
          }
          const machineClass = cloudMachines.resolve(target.profileId);
          const os = cloudMachines.resolveOs(target.profileId);
          finish({ ...target, ...(machineClass ? { machineClass } : {}), ...(os ? { os } : {}) });
        };

        function choices(profile: DraftCloudProfile) {
          machineRevision();
          const profileSelected = selectedKey() === `profile:${profile.id}`;
          const machines = cloudMachines.machines(profile);
          const operatingSystems = profile.operatingSystems ?? [];
          return [
            {
              kind: "os" as const,
              label: t("newSession.operatingSystem"),
              choices: operatingSystems,
              visible: profileSelected && operatingSystems.length >= 2,
              selectedId: cloudMachines.selectedOs(profile),
            },
            {
              kind: "machine" as const,
              label: t("newSession.machine"),
              choices: machines,
              visible: profileSelected && machines.length > 0,
              selectedId:
                cloudMachines.resolve(profile.id) ||
                machines.find((machine) => machine.default === true)?.id ||
                "",
            },
          ];
        }

        const complete = (loaded: Catalog | null, error?: unknown) => {
          if (modal.settled) {
            return;
          }
          if (loaded) {
            setCatalog(loaded);
          } else {
            setLoadError(formatUiError(error, t("sessionsView.moveSessionCatalogFailed")));
          }
          setLoading(false);
        };
        void options.loadCatalog().then(
          (loaded) => complete(loaded),
          (error: unknown) => complete(null, error),
        );

        return (
          <openclaw-modal-dialog label={title()} onModal-cancel={() => finish(null)}>
            <form class="exec-approval-card" onSubmit={submit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">{title()}</div>
                <div class="muted">
                  {t(`sessionsView.${options.mode}SessionDescription`, {
                    session: options.sessionLabel,
                  })}
                </div>
              </div>
              {options.mode === "restart" ? (
                <div class="exec-approval-error" role="alert">
                  {t("sessionsView.restartSessionWarning")}
                </div>
              ) : dispatch ? (
                <div class="callout">{t("sessionsView.dispatchSessionNotice")}</div>
              ) : options.activeRun ? (
                <div class="exec-approval-error" role="alert">
                  {t("sessionsView.moveSessionActiveRunWarning")}
                </div>
              ) : (
                <div class="callout">{t("sessionsView.moveSessionNoReplayWarning")}</div>
              )}
              {loading() ? (
                <div class="muted">{t("common.loading")}</div>
              ) : loadError() ? (
                <div class="exec-approval-error" role="alert">
                  {loadError()}
                </div>
              ) : (
                <div class="new-session-page__picker-root">
                  {!dispatch ? (
                    <LitContent
                      render={() =>
                        renderSessionMenuItem(
                          {
                            value: "gateway",
                            label: t("newSession.gateway"),
                            icon: icons.monitor,
                            checked: selectedKey() === "gateway",
                            disabled: Boolean(options.gatewayDisabledReason),
                            title: options.gatewayDisabledReason,
                            onSelect: () => select({ kind: "gateway" }),
                          },
                          false,
                        )
                      }
                    />
                  ) : null}
                  {catalog().devices.length > 0 ? (
                    <div class="new-session-page__menu-title">{t("newSession.yourDevices")}</div>
                  ) : null}
                  <For each={catalog().devices} keyed={(device) => device.deviceId}>
                    {(device) => (
                      <LitContent
                        render={() =>
                          renderSessionMenuItem(
                            {
                              value: `device:${device().deviceId}`,
                              label: device().label,
                              sub: device().subtitle,
                              icon: icons.monitor,
                              facts: options.deviceDisabledReason
                                ? [options.deviceDisabledReason]
                                : device().facts,
                              checked: selectedKey() === `device:${device().deviceId}`,
                              disabled:
                                Boolean(options.deviceDisabledReason) || !device().selectable,
                              title: options.deviceDisabledReason ?? device().disabledReason,
                              onSelect: () =>
                                select({ kind: "device", deviceId: device().deviceId }),
                            },
                            false,
                          )
                        }
                      />
                    )}
                  </For>
                  {profiles().length > 0 ? (
                    <div class="new-session-page__menu-title">{t("newSession.cloud")}</div>
                  ) : null}
                  <For each={profiles()} keyed={(profile) => profile.id}>
                    {(profile) => (
                      <>
                        <LitContent
                          render={() =>
                            renderCloudProfileMenuItems({
                              profiles: [profile()],
                              selectedId:
                                selectedKey() === `profile:${profile().id}` ? profile().id : "",
                              submitting: false,
                              profileDisabledReason: options.profileDisabledReason,
                              onSelect: (profileId) => select({ kind: "profile", profileId }),
                            })
                          }
                        />
                        <For each={choices(profile())} keyed={(choice) => choice.kind}>
                          {(choice) => (
                            <Show when={choice().visible}>
                              <div class="new-session-page__menu-title">{choice().label}</div>
                              <LitContent
                                render={() =>
                                  renderCloudChoiceMenuItems({
                                    kind: choice().kind,
                                    choices: choice().choices,
                                    selectedId: choice().selectedId,
                                    submitting: false,
                                    onSelect: (id) =>
                                      cloudMachines[choice().kind === "os" ? "selectOs" : "select"](
                                        profile().id,
                                        id,
                                        catalog().profiles,
                                        false,
                                        () => setMachineRevision((revision) => revision + 1),
                                      ),
                                  })
                                }
                              />
                            </Show>
                          )}
                        </For>
                      </>
                    )}
                  </For>
                </div>
              )}
              <div class="exec-approval-actions">
                <button
                  type="submit"
                  class="btn primary"
                  disabled={loading() || Boolean(loadError()) || !selected()}
                >
                  {t(`sessionsView.${options.mode}SessionAction`)}
                </button>
                <button type="button" class="btn" onClick={() => finish(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        );
      }
      modal.render(() => <Dialog />);
    },
    renderSolid,
  );
}
