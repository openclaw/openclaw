import { createMemo, For, Show } from "solid-js";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/web-awesome.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function deviceDesktopEnvironment(props: DevicesProps, environmentId: string) {
  return props.desktopEnvironments?.find(
    (environment) => environment.id === environmentId && environment.desktop === true,
  )?.id;
}

async function copyDeviceId(id: string) {
  const copied = await copyToClipboard(id);
  showToast({ message: copied ? t("devices.inventory.deviceIdCopied") : t("common.copyFailed") });
}

export function DeviceEntryMenu(props: {
  devices: DevicesProps;
  entry: {
    name: string;
    deviceId?: string;
    desktopEnvironment?: string;
    pendingRequestId?: string;
    onEditAlias?: () => void;
    onRemove?: () => void;
  };
}) {
  const actions = createMemo(() => [
    {
      value: "desktop",
      labelKey: "devices.inventory.openDesktop",
      visible: props.entry.desktopEnvironment,
      pairing: false,
      run: () =>
        props.entry.desktopEnvironment &&
        openDesktopFocus(props.devices.basePath, props.entry.desktopEnvironment),
    },
    {
      value: "approve",
      labelKey: "devices.inventory.approve",
      visible: props.entry.pendingRequestId,
      pairing: true,
      run: () =>
        props.entry.pendingRequestId && props.devices.onNodeApprove(props.entry.pendingRequestId),
    },
    {
      value: "reject",
      labelKey: "devices.inventory.reject",
      visible: props.entry.pendingRequestId,
      pairing: true,
      run: () =>
        props.entry.pendingRequestId && props.devices.onNodeReject(props.entry.pendingRequestId),
    },
    {
      value: "copy",
      labelKey: "devices.inventory.copyDeviceId",
      visible: props.entry.deviceId,
      pairing: false,
      run: () => props.entry.deviceId && void copyDeviceId(props.entry.deviceId),
    },
    {
      value: "editAlias",
      labelKey: "devices.inventory.editAlias",
      visible: props.entry.onEditAlias,
      pairing: true,
      run: () => props.entry.onEditAlias?.(),
    },
    {
      value: "remove",
      labelKey: "devices.inventory.removeAction",
      visible: props.entry.onRemove,
      pairing: true,
      run: () => props.entry.onRemove?.(),
    },
  ]);
  return (
    <Show when={props.entry.deviceId || props.entry.desktopEnvironment}>
      <wa-dropdown
        placement="bottom-end"
        onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
          const action = actions().find((item) => item.value === event.detail.item.value);
          if (action && (!action.pairing || props.devices.canManagePairing)) {
            action.run();
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class="btn btn--sm btn--ghost device-entry__menu-trigger"
          aria-label={t("devices.inventory.actionsName", { name: props.entry.name })}
          title={t("devices.inventory.actions")}
        >
          <Icon name="moreHorizontal" />
        </button>
        <For each={actions()} keyed={(action) => action.value}>
          {(action) => (
            <Show when={action().visible}>
              <wa-dropdown-item
                value={action().value}
                prop:disabled={action().pairing && !props.devices.canManagePairing}
                title={
                  action().pairing && !props.devices.canManagePairing
                    ? t("devices.readOnly.pairingRequired")
                    : undefined
                }
                prop:variant={action().value === "remove" ? "danger" : "default"}
              >
                {t(action().labelKey)}
              </wa-dropdown-item>
            </Show>
          )}
        </For>
      </wa-dropdown>
    </Show>
  );
}
