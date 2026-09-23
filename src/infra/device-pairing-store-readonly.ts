import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { DeviceBootstrapBoundContextInput } from "./device-bootstrap.worker-types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { captureDevicePairingPublication } from "./device-pairing-publication.js";
import type { DevicePairingReadCommand } from "./device-pairing-read.types.js";

async function readPairing(command: DevicePairingReadCommand, baseDir?: string, current = false) {
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
      return { reply };
    }
    if (!publication.isCurrent()) {
      return undefined;
    }
    if (reply?.ok && "bindings" in reply) {
      publication.publish(reply.revision, reply.bindings, reply.type === "devicePairing.list");
    } else if (!reply) {
      publication.publish("missing", [], true);
    }
    return { reply };
  };
  const observed = await read();
  if (observed) {
    return observed.reply;
  }
  // Only a superseded read joins writer admission; unrelated queued history must not block auth.
  return withDevicePairingLock(async () => {
    const refreshed = await read();
    if (!refreshed) {
      throw new Error("Device pairing read publication was replaced");
    }
    return refreshed.reply;
  });
}

/** Readers never create, migrate, or synchronously open the shared database. */
export async function listDevicePairingStoreRecordsReadOnly(baseDir?: string, current = false) {
  const reply = await readPairing(
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
  const reply = await readPairing(
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

export async function loadPendingDevicePairingStoreRecordReadOnly(
  requestId: string,
  baseDir?: string,
) {
  const reply = await readPairing(
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
  const reply = await readPairing({ type: "devicePairing.bootstrapContext", input }, baseDir, true);
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== "devicePairing.bootstrapContext") {
    throw new Error("Unexpected bootstrap context reply");
  }
  return reply.context;
}
