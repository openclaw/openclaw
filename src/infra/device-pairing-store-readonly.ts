import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { DeviceBootstrapBoundContextInput } from "./device-bootstrap.worker-types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import {
  captureDevicePairingPublication,
  DevicePairingPublicationUnavailableError,
  getPublishedOperatorPairingIdentity,
} from "./device-pairing-publication.js";
import type {
  DevicePairingNodeSnapshot,
  DevicePairingReadCommand,
} from "./device-pairing-read.types.js";

async function readPairing(
  command: DevicePairingReadCommand,
  baseDir?: string,
  current = false,
  prepareNodes = false,
) {
  const options = baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
  const context = captureOpenClawStateWorkerContext(options);
  const selected = { path: context.admission.databasePath, env: context.environment };
  const snapshot = current ? undefined : getActiveOpenClawStateDatabaseReadSnapshot(selected);
  const read = async () => {
    const publication = captureDevicePairingPublication(context.admission);
    let reply;
    try {
      reply = await executeExistingOpenClawStateRead(
        selected,
        command.type === "devicePairing.list" && !snapshot
          ? { ...command, publishedRevision: publication.completeRevision() }
          : command,
        { current },
      );
    } catch (error) {
      if (!snapshot) {
        publication.fail();
      }
      throw error;
    }
    context.admission.assertCurrent();
    if (snapshot) {
      return { reply, nodes: undefined };
    }
    if (!publication.isCurrent()) {
      return undefined;
    }
    if (reply?.ok && "bindings" in reply) {
      publication.publish(reply.revision, reply.bindings, reply.type === "devicePairing.list");
    } else if (!reply) {
      publication.publish("missing", [], true);
    }
    const nodes =
      prepareNodes && (!reply || (reply.ok && reply.type === "devicePairing.list"))
        ? publication.prepareNodes(reply?.revision ?? "missing", reply?.list.paired ?? [])
        : undefined;
    return { reply, nodes };
  };
  const observed = await read();
  if (observed) {
    return observed;
  }
  // Only a superseded read joins writer admission; unrelated queued history must not block auth.
  return withDevicePairingLock(async () => {
    const refreshed = await read();
    if (!refreshed) {
      throw new Error("Device pairing read publication was replaced");
    }
    return refreshed;
  });
}

/** Current paired rows and prepared node bindings share the publication's revision and lifetime. */
export async function readDevicePairingNodeSnapshot(
  baseDir?: string,
): Promise<DevicePairingNodeSnapshot> {
  const { nodes } = await readPairing(
    { type: "devicePairing.list", nowMs: Date.now() },
    baseDir,
    true,
    true,
  );
  if (!nodes) {
    throw new Error("Unexpected pairing node snapshot reply");
  }
  return nodes;
}

/** Readers never create, migrate, or synchronously open the shared database. */
export async function listDevicePairingStoreRecordsReadOnly(baseDir?: string, current = false) {
  const { reply } = await readPairing(
    { type: "devicePairing.list", nowMs: Date.now() },
    baseDir,
    current,
  );
  if (!reply) {
    return { pending: [], paired: [] };
  }
  if (!reply.ok || reply.type !== "devicePairing.list") {
    throw new Error("Unexpected pairing list reply");
  }
  return reply.list;
}

export async function loadPairedDevicePairingStoreRecordReadOnly(
  deviceId: string,
  baseDir?: string,
) {
  const { reply } = await readPairing(
    { type: "devicePairing.lookup", deviceId: deviceId.trim() },
    baseDir,
    true,
  );
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== "devicePairing.lookup") {
    throw new Error("Unexpected pairing lookup reply");
  }
  return reply.device;
}

/** Reuse admitted pairing facts; only an unavailable publication needs worker preparation. */
export async function prepareOperatorPairingIdentity(deviceId: string, baseDir?: string) {
  try {
    return getPublishedOperatorPairingIdentity(deviceId, baseDir);
  } catch (error) {
    if (!(error instanceof DevicePairingPublicationUnavailableError)) {
      throw error;
    }
  }
  await loadPairedDevicePairingStoreRecordReadOnly(deviceId, baseDir);
  return getPublishedOperatorPairingIdentity(deviceId, baseDir);
}

export async function loadPendingDevicePairingStoreRecordReadOnly(
  requestId: string,
  baseDir?: string,
) {
  const { reply } = await readPairing(
    { type: "devicePairing.pending", requestId, nowMs: Date.now() },
    baseDir,
    true,
  );
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== "devicePairing.pending") {
    throw new Error("Unexpected pending pairing reply");
  }
  return reply.pending;
}

export async function loadBoundDeviceBootstrapContextReadOnly(
  input: DeviceBootstrapBoundContextInput,
  baseDir?: string,
) {
  const { reply } = await readPairing(
    { type: "devicePairing.bootstrapContext", input },
    baseDir,
    true,
  );
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== "devicePairing.bootstrapContext") {
    throw new Error("Unexpected bootstrap context reply");
  }
  return reply.context;
}
