import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, For } from "solid-js";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatList, formatRelativeTimestamp } from "../../lib/format.ts";
import type { PairedDevice, PendingDevice } from "../../lib/nodes/index.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { DeviceEntryMenu } from "./entry-menu.tsx";
import { DeviceTile, DeviceIdentityFacts } from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function PendingDeviceRows(props: {
  pending: PendingDevice[];
  paired: PairedDevice[];
  devices: DevicesProps;
}) {
  const pairedByDeviceId = createMemo(
    () =>
      new Map(
        props.paired
          .map((device) => [normalizeOptionalString(device.deviceId), device] as const)
          .filter((entry): entry is [string, PairedDevice] => Boolean(entry[0])),
      ),
  );
  return (
    <For each={props.pending} keyed={(req) => req.requestId}>
      {(req) => (
        <PendingDevice
          req={req()}
          devices={props.devices}
          paired={lookupPairedDevice(pairedByDeviceId(), req())}
        />
      )}
    </For>
  );
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const paired = pairedByDeviceId.get(normalizeOptionalString(request.deviceId) ?? "");
  if (!paired) {
    return undefined;
  }
  const requestPublicKey = normalizeOptionalString(request.publicKey);
  const pairedPublicKey = normalizeOptionalString(paired.publicKey);
  if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) {
    return undefined;
  }
  return paired;
}

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return t("devices.inventory.none");
  }
  return t("devices.inventory.rolesAndScopes", {
    roles: formatList(access.roles),
    scopes: formatList(access.scopes),
  });
}

const PENDING_APPROVAL_LABELS: Record<PendingDeviceApprovalKind, string> = {
  "scope-upgrade": "devices.inventory.scopeUpgrade",
  "role-upgrade": "devices.inventory.roleUpgrade",
  "re-approval": "devices.inventory.reapproval",
  "new-pairing": "devices.inventory.newPairing",
};

function PendingDevice(props: {
  req: PendingDevice;
  devices: DevicesProps;
  paired?: PairedDevice;
}) {
  const name = createMemo(
    () => normalizeOptionalString(props.req.displayName) || props.req.deviceId,
  );
  const age = createMemo(() =>
    typeof props.req.ts === "number" ? formatRelativeTimestamp(props.req.ts) : t("common.na"),
  );
  const approval = createMemo(() => resolvePendingDeviceApprovalState(props.req, props.paired));
  const repair = createMemo(() =>
    props.req.isRepair ? ` · ${t("devices.inventory.repair")}` : "",
  );
  return (
    <div class="settings-row device-entry">
      <DeviceTile icon={<Icon name="monitorSmartphone" />} />
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">{name()}</span>
          <span class="device-entry__status">
            <SettingsStatus kind={"warn"} label={t("devices.inventory.pendingApproval")} />
          </span>
        </div>
        <span class="settings-row__desc">
          {t("devices.inventory.requestedAt", {
            note: t(PENDING_APPROVAL_LABELS[approval().kind]),
            time: age(),
          })}
          {repair()}
        </span>
      </div>
      <div class="settings-row__control">
        <button
          class="btn btn--sm"
          disabled={!props.devices.canManagePairing}
          onClick={() => props.devices.onDeviceApprove(props.req.requestId)}
        >
          {t("devices.inventory.approve")}
        </button>
        <button
          class="btn btn--sm"
          disabled={!props.devices.canManagePairing}
          onClick={() => props.devices.onDeviceReject(props.req.requestId)}
        >
          {t("devices.inventory.reject")}
        </button>
        <DeviceEntryMenu
          devices={props.devices}
          entry={{ name: name(), deviceId: props.req.deviceId }}
        />
      </div>
      <details class="device-entry__details">
        <summary>{t("devices.inventory.details")}</summary>
        <dl class="device-entry__facts">
          <DeviceIdentityFacts id={props.req.deviceId} remoteIp={props.req.remoteIp} />
          <dt class="settings-row__desc">{t("devices.inventory.requestedAccessLabel")}</dt>
          <dd class="settings-row__value">{formatAccessSummary(approval().requested)}</dd>
          {approval().approved ? (
            <>
              <dt class="settings-row__desc">{t("devices.inventory.approvedAccessLabel")}</dt>
              <dd class="settings-row__value">{formatAccessSummary(approval().approved)}</dd>
            </>
          ) : undefined}
        </dl>
      </details>
    </div>
  );
}
