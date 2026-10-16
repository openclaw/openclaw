import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateWorkerContext,
  captureOpenClawStateReadContext,
} from "../state/openclaw-state-worker-context.js";
import type { DeviceBootstrapBoundContextInput } from "./device-bootstrap.worker-types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { captureDevicePairingPublication } from "./device-pairing-publication.js";
import type {
  DevicePairingNodeSnapshot,
  DevicePairingReadCommand,
} from "./device-pairing-read.types.js";

async function readPairing<Command extends DevicePairingReadCommand>(
  command: Command,
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
    const nodes = prepareNodes && !snapshot ? publication.readNodes() : undefined;
    if (nodes) {
      context.admission.assertCurrent();
      return { reply: undefined, nodes };
    }
    let reply;
    try {
      const selectedCommand: Command =
        command.type === "devicePairing.list" && !snapshot
          ? { ...command, publishedRevision: publication.completeRevision() }
          : command;
      reply = await executeExistingOpenClawStateRead(selected, selectedCommand, { current });
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
    if (reply && "bindings" in reply) {
      publication.publish(reply.revision, reply.bindings, reply.type === "devicePairing.list");
    } else if (!reply) {
      publication.publish("missing", [], true);
    }
    const preparedNodes =
      prepareNodes && (!reply || "list" in reply)
        ? publication.prepareNodes(reply?.revision ?? "missing", reply?.list.paired ?? [])
        : undefined;
    return { reply, nodes: preparedNodes };
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
  return reply.list;
}

export async function loadPairedDevicePairingStoreRecordReadOnly(
  deviceId: string,
  baseDir?: string,
) {
  const context = captureOpenClawStateReadContext(
    resolveOpenClawStateSqlitePath(
      baseDir ? { ...process.env, OPENCLAW_STATE_DIR: baseDir } : process.env,
    ),
  );
  const device = captureDevicePairingPublication(context.admission).readDevice(deviceId.trim());
  if (device !== undefined) {
    context.admission.assertCurrent();
    return device;
  }
  const { reply } = await readPairing(
    { type: "devicePairing.lookup", deviceId: deviceId.trim() },
    baseDir,
    true,
  );
  if (!reply) {
    return null;
  }
  return reply.device;
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
  return reply.context;
}
