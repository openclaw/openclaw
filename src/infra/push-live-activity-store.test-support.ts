import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { resolveNodePairingGeneration, type PairedDevice } from "./device-pairing.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  LiveActivityStore,
  type LiveActivityDestination,
  type LiveActivityDeliveryOwner,
  type LiveActivityObservation,
  type LiveActivityOwnerIsCurrent,
  type LiveActivityRegistrationInput,
} from "./push-live-activity-store.js";

export const TABLE = "apns_live_activities";
export const isCurrent: LiveActivityOwnerIsCurrent = () => true;
export const isReady: LiveActivityDeliveryOwner = () => "ready";
export const destination = {
  transport: "direct",
  token: "a".repeat(64),
  topic: "ai.openclaw.ios",
  environment: "sandbox",
} satisfies LiveActivityDestination;
export const relay = {
  transport: "relay",
  relayHandle: "activity-handle",
  sendGrant: "activity-grant",
  installationId: "test-installation",
  relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai",
  relayRevision: 1,
  topic: "ai.openclaw.ios",
  environment: "sandbox",
} satisfies LiveActivityDestination;

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Unexpected store failure: ${String(result.error)}`);
  }
  return result.value;
}

function pairedDevice(id = "node-1"): PairedDevice {
  return {
    deviceId: id,
    publicKey: `test-public-key-${id}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: { token: `test-node-token-${id}`, role: "node", scopes: [], createdAtMs: 100 },
    },
    nodeSurface: { createdAtMs: 200, approvedAtMs: 300 },
    createdAtMs: 50,
    approvedAtMs: 300,
  };
}

export function createLiveActivityStoreFixture(dir: string, readNow: () => number, pair = true) {
  const options = {
    path: path.join(dir, "state", "openclaw.sqlite"),
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
    },
  };
  const device = pairedDevice();
  const generation = resolveNodePairingGeneration(device);
  if (!generation) {
    throw new Error("Fixture requires an approved node generation");
  }
  const input: LiveActivityRegistrationInput = {
    activityId: "activity-1",
    binding: {
      gatewayId: "gateway-1",
      deviceId: device.deviceId,
      nodeId: device.deviceId,
      pairingGeneration: generation.key,
      profileId: "profile-1",
      agentId: "main",
      sessionKey: "agent:main:activity-test",
      sessionId: "session-generation-1",
      lifecycleRevision: null,
      publicRunId: "public-run-1",
    },
    sourceIncarnation: "source-owner-1",
    destination,
  };
  const persistPairing = (devices: PairedDevice[]) =>
    persistDevicePairingStoreState(
      {
        pendingById: {},
        pairedByDeviceId: Object.fromEntries(devices.map((entry) => [entry.deviceId, entry])),
      },
      dir,
      "paired",
    );
  if (pair) {
    persistPairing([device]);
  }
  const store = new LiveActivityStore(options);
  const saved = (patch: Partial<LiveActivityRegistrationInput> = {}) =>
    value(store.register({ ...input, ...patch }, isCurrent));
  const fact = (patch: Partial<LiveActivityObservation> = {}): LiveActivityObservation => {
    const base = {
      sourceIncarnation: patch.sourceIncarnation ?? input.sourceIncarnation,
      observedAtMs: patch.observedAtMs ?? readNow(),
      startedAtMs: patch.startedAtMs,
    };
    const status = patch.status ?? "running";
    return status === "running" || status === "toolRunning" || status === "approvalNeeded"
      ? { ...base, status, sequence: "sequence" in patch ? (patch.sequence ?? 1) : 1 }
      : { ...base, status, endedAtMs: "endedAtMs" in patch ? patch.endedAtMs : undefined };
  };
  const row = (id: string) => {
    const { db } = openOpenClawStateDatabase(options);
    const found = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db).selectFrom(TABLE).selectAll().where("registration_id", "=", id),
    );
    if (!found) {
      throw new Error("Fixture row is missing");
    }
    return found;
  };
  const observe = (id: string, patch: Partial<LiveActivityObservation> = {}) =>
    value(store.observe(id, fact(patch), isCurrent));
  return { dir, options, device, input, store, saved, fact, row, observe, persistPairing };
}
