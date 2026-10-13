import type { DatabaseSync } from "node:sqlite";
import { getBoundDeviceBootstrapContextFromRecords } from "./device-bootstrap.worker-kernel.js";
import { prepareDevicePairingBinding } from "./device-pairing-binding.js";
import type {
  DevicePairingBindingFact,
  DevicePairingReadCommand,
  DevicePairingReadReply,
} from "./device-pairing-read.types.js";
import { readCachedDevicePairingStoreSnapshot } from "./device-pairing-store-cache.js";
import {
  readDevicePairingStoreStateFromDatabase,
  readDeviceBootstrapTokenRecordsFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";

// The borrowed store snapshot owns invalidation; obsolete projections are collectable with it.
const bindingsBySnapshot = new WeakMap<DevicePairingStoreState, DevicePairingBindingFact[]>();

export function executeDevicePairingRead(
  db: DatabaseSync,
  path: string,
  command: DevicePairingReadCommand,
): DevicePairingReadReply {
  const { state, revision } = readCachedDevicePairingStoreSnapshot(db, path, () =>
    readDevicePairingStoreStateFromDatabase(db),
  );
  const common = { ok: true as const, sourceAdmitted: true as const, revision };
  if (command.type === "devicePairing.lookup") {
    const deviceId = command.deviceId.trim();
    const device = Object.hasOwn(state.pairedByDeviceId, deviceId)
      ? state.pairedByDeviceId[deviceId]!
      : null;
    return {
      ...common,
      type: command.type,
      device,
      bindings: [prepareDevicePairingBinding(deviceId, device)],
    };
  }
  if (command.type === "devicePairing.bootstrapContext") {
    return {
      ...common,
      type: command.type,
      bindings: [],
      context: getBoundDeviceBootstrapContextFromRecords(
        readDeviceBootstrapTokenRecordsFromDatabase(db),
        command.input,
      ),
    };
  }
  if (command.type === "devicePairing.pending") {
    const record = state.pendingById[command.requestId];
    const pending =
      record && command.nowMs - (record.refreshedAtMs ?? record.ts) <= 5 * 60 * 1000
        ? (({ refreshedAtMs: _refreshedAtMs, ...request }) => request)(record)
        : null;
    return { ...common, type: command.type, pending, bindings: [] };
  }
  let bindings = bindingsBySnapshot.get(state);
  if (!bindings) {
    bindings = Object.values(state.pairedByDeviceId).map((device) =>
      prepareDevicePairingBinding(device.deviceId, device),
    );
    bindingsBySnapshot.set(state, bindings);
  }
  return {
    ...common,
    type: command.type,
    bindings: command.publishedRevision === revision ? undefined : bindings,
    list: {
      pending: Object.values(state.pendingById)
        .filter((record) => command.nowMs - (record.refreshedAtMs ?? record.ts) <= 5 * 60 * 1000)
        .map(({ refreshedAtMs: _refreshedAtMs, ...request }) => request)
        .toSorted((a, b) => b.ts - a.ts),
      paired: Object.values(state.pairedByDeviceId).toSorted(
        (a, b) => b.approvedAtMs - a.approvedAtMs,
      ),
    },
  };
}
