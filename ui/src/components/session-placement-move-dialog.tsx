import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  CloudChoiceMenuItems,
  CloudProfileMenuItems,
  SessionMenuItem,
} from "../pages/new-session/cloud-target-view.tsx";
import type { DevicePlacementOption } from "../pages/new-session/device-placement.ts";
import type { DraftCloudProfile } from "../pages/new-session/discovery.ts";
import { DraftCloudMachineState } from "../pages/new-session/draft-cloud-machine-state.ts";
import "../styles/new-session.css";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { compareCloudProfiles } from "./provider-icon-data.ts";
import { Icon } from "./solid/icon.tsx";

registerNewSessionSetupEnglish();

type Catalog = {
  profiles: readonly DraftCloudProfile[];
  devices: readonly DevicePlacementOption[];
};

type Options = {
  mode: "dispatch" | "move" | "restart";
  sessionLabel: string;
  activeRun: boolean;
  repositoryOnly?: boolean;
  allowMachineOverrides?: boolean;
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
  return target.kind === "gateway"
    ? "gateway"
    : `${target.kind}:${target.kind === "profile" ? target.profileId : target.deviceId}`;
}

export function showSessionPlacementTargetDialog(
  options: Options,
): Promise<SessionMoveTarget | null> {
  if (active) {
    return Promise.resolve(null);
  }
  active = true;
  return withPromiseModalHost<SessionMoveTarget | null>(undefined, ({ finish, render }) => {
    function Dialog() {
      const loaded = createMemo<Catalog | string | null>(
        () =>
          options
            .loadCatalog()
            .catch((error: unknown) =>
              untrack(() => formatUiError(error, t("sessionsView.moveSessionCatalogFailed"))),
            ),
        { loadingValue: null },
      );
      const loadError = createMemo(() => {
        const value = loaded();
        return typeof value === "string" ? value : null;
      });
      const catalog = createMemo(() => {
        const value = loaded();
        return value && typeof value !== "string" ? value : { profiles: [], devices: [] };
      });
      const [selected, select] = createSignal<SessionMoveTarget | null>(
        options.mode === "move" && !options.gatewayDisabledReason ? { kind: "gateway" } : null,
      );
      const [machineRevision, setMachineRevision] = createSignal(0);
      const cloudMachines = new DraftCloudMachineState();
      const selectedKey = createMemo(() => targetKey(selected()));
      const profiles = createMemo(() => catalog().profiles.toSorted(compareCloudProfiles));
      const title = () => t(`sessionsView.${options.mode}SessionTitle`);
      const dispatch = options.mode === "dispatch";
      const warning = options.mode === "restart" || (!dispatch && options.activeRun);
      const notice = {
        restart: "restartSessionWarning",
        dispatch: options.repositoryOnly ? "dispatchSessionNotice" : "dispatchLocalSessionNotice",
        move: options.activeRun ? "moveSessionActiveRunWarning" : "moveSessionNoReplayWarning",
      }[options.mode];

      const selectable = () => {
        const target = selected();
        if (loaded() === null || loadError() || !target) {
          return false;
        }
        if (target.kind === "gateway") {
          return !dispatch && !options.gatewayDisabledReason;
        }
        if (target.kind === "device") {
          return (
            !options.deviceDisabledReason &&
            catalog().devices.some(
              (device) => device.deviceId === target.deviceId && device.selectable,
            )
          );
        }
        return profiles().some(
          (profile) => profile.id === target.profileId && !options.profileDisabledReason?.(profile),
        );
      };
      const submit = (event: Event) => {
        event.preventDefault();
        const target = selected();
        if (!target || !selectable()) {
          return;
        }
        if (target.kind !== "profile" || options.allowMachineOverrides === false) {
          finish(target);
          return;
        }
        const { machineClass, os } = cloudMachines.selection(target.profileId, catalog().profiles);
        finish({ ...target, ...(machineClass ? { machineClass } : {}), ...(os ? { os } : {}) });
      };

      function choices(profile: DraftCloudProfile) {
        machineRevision();
        const profileSelected =
          options.allowMachineOverrides !== false && selectedKey() === `profile:${profile.id}`;
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
            selectedId: cloudMachines.selection(profile.id, catalog().profiles).machineClass,
          },
        ];
      }

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
            <div
              class={warning ? "exec-approval-error" : "callout"}
              role={warning ? "alert" : undefined}
            >
              {t(`sessionsView.${notice}`)}
            </div>
            {loaded() === null ? (
              <div class="muted">{t("common.loading")}</div>
            ) : loadError() ? (
              <div class="exec-approval-error" role="alert">
                {loadError()}
              </div>
            ) : (
              <div class="new-session-page__picker-root">
                {!dispatch ? (
                  <SessionMenuItem
                    item={{
                      value: "gateway",
                      label: t("newSession.gateway"),
                      icon: <Icon name="monitor" />,
                      checked: selectedKey() === "gateway",
                      disabled: Boolean(options.gatewayDisabledReason),
                      title: options.gatewayDisabledReason,
                      onSelect: () => select({ kind: "gateway" }),
                    }}
                    submitting={false}
                  />
                ) : null}
                {catalog().devices.length > 0 ? (
                  <div class="new-session-page__menu-title">{t("newSession.yourDevices")}</div>
                ) : null}
                <For each={catalog().devices} keyed={(device) => device.deviceId}>
                  {(device) => (
                    <SessionMenuItem
                      item={{
                        value: `device:${device().deviceId}`,
                        label: device().label,
                        sub: device().subtitle,
                        icon: <Icon name="monitor" />,
                        facts: options.deviceDisabledReason
                          ? [options.deviceDisabledReason]
                          : device().facts,
                        checked: selectedKey() === `device:${device().deviceId}`,
                        disabled: Boolean(options.deviceDisabledReason) || !device().selectable,
                        title: options.deviceDisabledReason ?? device().disabledReason,
                        onSelect: () => select({ kind: "device", deviceId: device().deviceId }),
                      }}
                      submitting={false}
                    />
                  )}
                </For>
                {profiles().length > 0 ? (
                  <div class="new-session-page__menu-title">{t("newSession.cloud")}</div>
                ) : null}
                <For each={profiles()} keyed={(profile) => profile.id}>
                  {(profile) => (
                    <>
                      <CloudProfileMenuItems
                        params={{
                          profiles: [profile()],
                          selectedId:
                            selectedKey() === `profile:${profile().id}` ? profile().id : "",
                          submitting: false,
                          profileDisabledReason: options.profileDisabledReason,
                          onSelect: (profileId) => select({ kind: "profile", profileId }),
                        }}
                      />
                      <For each={choices(profile())} keyed={(choice) => choice.kind}>
                        {(choice) => (
                          <Show when={choice().visible}>
                            <div class="new-session-page__menu-title">{choice().label}</div>
                            <CloudChoiceMenuItems
                              params={{
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
                              }}
                            />
                          </Show>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            )}
            <openclaw-modal-actions class="exec-approval-actions">
              <button type="submit" class="btn primary" disabled={!selectable()}>
                {t(`sessionsView.${options.mode}SessionAction`)}
              </button>
              <button type="button" class="btn" onClick={() => finish(null)}>
                {t("common.cancel")}
              </button>
            </openclaw-modal-actions>
          </form>
        </openclaw-modal-dialog>
      );
    }
    render(() => <Dialog />);
  }).finally(() => {
    active = false;
  });
}
