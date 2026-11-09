import { Show } from "solid-js";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function deviceDesktopEnvironment(props: DevicesProps, environmentId: string) {
  return props.desktopEnvironments?.find(
    (environment) => environment.id === environmentId && environment.desktop === true,
  )?.id;
}

/** Every request carries the same weight: an accent would read as a recommendation. */
export function PendingDecisions(props: {
  devices: DevicesProps;
  requestId: string;
  name: string;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}) {
  const disabled = () =>
    props.devices.inventorySaving ||
    !props.devices.connected ||
    !props.devices.canManagePairing ||
    props.devices.devicesDeciding.some((decision) => decision.requestId === props.requestId);
  return (
    <>
      <button
        class="btn btn--sm device-entry__approve"
        data-device-action="approve"
        disabled={disabled()}
        aria-label={t("devices.inventory.approveName", { name: props.name })}
        onClick={() => props.onApprove(props.requestId)}
      >
        {t("devices.inventory.approve")}
      </button>
      <button
        class="btn btn--sm"
        data-device-action="reject"
        disabled={disabled()}
        aria-label={t("devices.inventory.rejectName", { name: props.name })}
        onClick={() => props.onReject(props.requestId)}
      >
        {t("devices.inventory.reject")}
      </button>
    </>
  );
}

/** What one device can do, shown only once its row is open. */
export function DeviceEntryActions(props: {
  devices: DevicesProps;
  desktopEnvironment?: string;
  onEditAlias?: () => void;
  onRemove?: () => void;
}) {
  const disabled = () =>
    props.devices.inventorySaving || !props.devices.connected || !props.devices.canManagePairing;
  const deniedTitle = () =>
    props.devices.connected && !props.devices.canManagePairing
      ? t("devices.readOnly.pairingRequired")
      : undefined;
  return (
    <Show when={props.desktopEnvironment || props.onEditAlias || props.onRemove}>
      <div class="device-entry__actions">
        <Show when={props.desktopEnvironment}>
          {(environmentId) => (
            // Settings routes suppress the docked Desktop panel, so the row opens the
            // standalone desktop focus window instead of dispatching a panel toggle.
            <button
              class="btn btn--sm device-entry__desktop"
              data-device-action="desktop"
              title={t("devices.inventory.desktopOpenWindow")}
              onClick={() => openDesktopFocus(props.devices.basePath, environmentId())}
            >
              {t("devices.inventory.openDesktop")}
            </button>
          )}
        </Show>
        <Show when={props.onEditAlias}>
          {(onEditAlias) => (
            <button
              class="btn btn--sm device-entry__alias"
              data-device-action="editAlias"
              disabled={disabled()}
              title={deniedTitle()}
              onClick={() => onEditAlias()()}
            >
              {t("devices.inventory.editAlias")}
            </button>
          )}
        </Show>
        <Show when={props.onRemove}>
          {(onRemove) => (
            <button
              class="btn btn--sm danger device-entry__remove"
              data-device-action="remove"
              disabled={disabled()}
              title={deniedTitle()}
              onClick={() => onRemove()()}
            >
              {t("devices.inventory.removeAction")}
            </button>
          )}
        </Show>
      </div>
    </Show>
  );
}
