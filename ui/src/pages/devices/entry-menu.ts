import { html, nothing } from "lit";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { icons } from "../../components/icons.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { showToast } from "../../lib/toast.ts";
import type { DevicesProps } from "./view.types.ts";

registerDevicesEnglish();

export function deviceDesktopEnvironment(props: DevicesProps, environmentId: string) {
  return props.desktopEnvironments?.find(
    (environment) => environment.id === environmentId && environment.desktop === true,
  )?.id;
}

async function copyDeviceId(id: string) {
  const copied = await copyToClipboard(id);
  showToast({ message: copied ? t("devices.inventory.deviceIdCopied") : t("common.copyFailed") });
}

export function renderDeviceEntryMenu(
  props: DevicesProps,
  entry: {
    name: string;
    deviceId?: string;
    desktopEnvironment?: string;
    pendingRequestId?: string;
    onEditAlias?: () => void;
    onRemove?: () => void;
  },
) {
  if (!entry.deviceId && !entry.desktopEnvironment) {
    return nothing;
  }
  const actions = [
    {
      value: "desktop",
      labelKey: "devices.inventory.openDesktop",
      visible: entry.desktopEnvironment,
      pairing: false,
      run: () =>
        entry.desktopEnvironment && openDesktopFocus(props.basePath, entry.desktopEnvironment),
    },
    {
      value: "approve",
      labelKey: "devices.inventory.approve",
      visible: entry.pendingRequestId,
      pairing: true,
      run: () => entry.pendingRequestId && props.onNodeApprove(entry.pendingRequestId),
    },
    {
      value: "reject",
      labelKey: "devices.inventory.reject",
      visible: entry.pendingRequestId,
      pairing: true,
      run: () => entry.pendingRequestId && props.onNodeReject(entry.pendingRequestId),
    },
    {
      value: "copy",
      labelKey: "devices.inventory.copyDeviceId",
      visible: entry.deviceId,
      pairing: false,
      run: () => entry.deviceId && void copyDeviceId(entry.deviceId),
    },
    {
      value: "editAlias",
      labelKey: "devices.inventory.editAlias",
      visible: entry.onEditAlias,
      pairing: true,
      run: () => entry.onEditAlias?.(),
    },
    {
      value: "remove",
      labelKey: "devices.inventory.removeAction",
      visible: entry.onRemove,
      pairing: true,
      run: () => entry.onRemove?.(),
    },
  ];
  return html`
    <wa-dropdown
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const action = actions.find((item) => item.value === event.detail.item.value);
        if (action && (!action.pairing || props.canManagePairing)) {
          action.run();
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost device-entry__menu-trigger"
        aria-label=${t("devices.inventory.actionsName", { name: entry.name })}
        title=${t("devices.inventory.actions")}
      >
        ${icons.moreHorizontal}
      </button>
      ${actions.map((action) =>
        action.visible
          ? html`
              <wa-dropdown-item
                value=${action.value}
                ?disabled=${action.pairing && !props.canManagePairing}
                title=${action.pairing && !props.canManagePairing ? t("devices.readOnly.pairingRequired") : nothing}
                variant=${action.value === "remove" ? "danger" : nothing}
                >${t(action.labelKey)}</wa-dropdown-item
              >
            `
          : nothing,
      )}
    </wa-dropdown>
  `;
}
