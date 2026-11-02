import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatList, formatRelativeTimestamp } from "../../lib/format.ts";
import type { PairedDevice, PendingDevice } from "../../lib/nodes/index.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { CapabilityList } from "./capability-list.tsx";
import { PendingDecisions } from "./entry-actions.tsx";
import { CommandFact, DeviceFact, DeviceIdentityFacts, MetaLine } from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function PendingDeviceRows(props: DevicesProps) {
  const pairedByDeviceId = createMemo(
    () =>
      new Map(
        (props.devicesList?.paired ?? [])
          .map((device) => [normalizeOptionalString(device.deviceId), device] as const)
          .filter((entry): entry is [string, PairedDevice] => Boolean(entry[0])),
      ),
  );
  return (
    <For each={props.devicesList?.pending ?? []} keyed={(req) => req.requestId}>
      {(req) => (
        <PendingDevice
          req={req()}
          devices={props}
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

function AccessSummary(props: { access: DevicePairingAccessSummary | null }) {
  return (
    <Show when={props.access} fallback={t("devices.inventory.none")}>
      {(access) => (
        <>
          <span class="device-fact__line">
            {t("devices.inventory.accessRoles", { roles: formatList(access().roles) })}
          </span>{" "}
          <span class="device-fact__line">
            {t("devices.inventory.accessScopes", { scopes: formatList(access().scopes) })}
          </span>
        </>
      )}
    </Show>
  );
}

const PENDING_APPROVAL_LABELS: Record<PendingDeviceApprovalKind, string> = {
  "scope-upgrade": "devices.inventory.scopeUpgrade",
  "role-upgrade": "devices.inventory.roleUpgrade",
  "re-approval": "devices.inventory.reapproval",
  "new-pairing": "devices.inventory.newPairing",
};

/** A decision shows what it needs in the open: who asks, why, and for what. */
function PendingRow(props: {
  name: string;
  note: readonly string[];
  decisions: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="settings-row device-entry device-entry--pending">
      <div class="settings-row__text">
        <span class="settings-row__title">{props.name}</span>
        <MetaLine parts={props.note} />
      </div>
      <div class="settings-row__control">{props.decisions}</div>
      <dl class="device-entry__facts">{props.children}</dl>
    </div>
  );
}

function PendingDevice(props: {
  req: PendingDevice;
  devices: DevicesProps;
  paired?: PairedDevice;
}) {
  const name = () => normalizeOptionalString(props.req.displayName) || props.req.deviceId;
  const age = createMemo(() =>
    props.req.ts === undefined ? t("common.na") : formatRelativeTimestamp(props.req.ts),
  );
  const approval = createMemo(() => resolvePendingDeviceApprovalState(props.req, props.paired));
  return (
    <PendingRow
      name={name()}
      note={[
        t(PENDING_APPROVAL_LABELS[approval().kind]),
        t("devices.inventory.requestedAt", { time: age() }),
        ...(props.req.isRepair ? [t("devices.inventory.repair")] : []),
        ...(props.req.remoteIp ? [props.req.remoteIp] : []),
      ]}
      decisions={
        <PendingDecisions
          devices={props.devices}
          requestId={props.req.requestId}
          name={name()}
          onApprove={props.devices.onDeviceApprove}
          onReject={props.devices.onDeviceReject}
        />
      }
    >
      <DeviceFact label={t("devices.inventory.requestedAccessLabel")}>
        <AccessSummary access={approval().requested} />
      </DeviceFact>
      <Show when={approval().approved}>
        <DeviceFact label={t("devices.inventory.approvedAccessLabel")}>
          <AccessSummary access={approval().approved} />
        </DeviceFact>
      </Show>
      <DeviceIdentityFacts id={props.req.deviceId} />
    </PendingRow>
  );
}

/** Node approvals are the same decision as device requests, so they sit beside them. */
export function PendingNode(props: { node: NodeListNode; devices: DevicesProps }) {
  const name = () => normalizeOptionalString(props.node.displayName) || props.node.nodeId;
  return (
    <PendingRow
      name={name()}
      note={[
        t(
          props.node.approvalState === "pending-reapproval"
            ? "devices.inventory.reapproval"
            : "devices.inventory.newPairing",
        ),
        ...(props.node.remoteIp ? [props.node.remoteIp] : []),
      ]}
      decisions={
        <PendingDecisions
          devices={props.devices}
          requestId={props.node.pendingRequestId ?? ""}
          name={name()}
          onApprove={props.devices.onNodeApprove}
          onReject={props.devices.onNodeReject}
        />
      }
    >
      <Show when={(props.node.pendingDeclaredCaps ?? []).length > 0}>
        <DeviceFact label={t("devices.inventory.capabilities")}>
          <CapabilityList caps={props.node.pendingDeclaredCaps ?? []} />
        </DeviceFact>
      </Show>
      <CommandFact values={props.node.pendingDeclaredCommands ?? []} />
      <DeviceIdentityFacts id={props.node.nodeId} />
    </PendingRow>
  );
}
