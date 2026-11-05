import type { DevicePairSetupCompletedEvent } from "../../packages/gateway-protocol/src/index.js";
import {
  confirmDevicePairSetupCompletionDelivery,
  consumeDeviceBootstrapTokenWithSetupCompletion,
} from "../infra/device-bootstrap.js";
import type { CloudWorkerSetupMutationAdmission } from "../infra/device-bootstrap.worker-types.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
} from "../infra/device-pairing.types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

export type SetupHandoff = {
  record: DeviceBootstrapTokenRecord;
  completion?: DevicePairSetupCompletionRecord;
};

// Consumption retires the bearer and records an uncertain handoff before the
// response. A separate confirmation makes operator-visible success truthful.
export async function consumeSetupHandoff(params: {
  token: string;
  deviceId: string;
  pairedDeviceMatches?: (device: PairedDevice | null) => boolean;
  admitsCloudWorkerSetup?: (setup: CloudWorkerSetupMutationAdmission) => boolean;
  baseDir?: string;
  ts?: number;
}): Promise<SetupHandoff | null> {
  const completedAtMs = params.ts ?? Date.now();
  return consumeDeviceBootstrapTokenWithSetupCompletion({
    token: params.token,
    deviceId: params.deviceId,
    completedAtMs,
    admitsCloudWorkerSetup: params.admitsCloudWorkerSetup,
    ...(params.pairedDeviceMatches ? { pairedDeviceMatches: params.pairedDeviceMatches } : {}),
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
}

/** Confirm the response completed before the operator can observe success. */
export async function confirmSetupHandoffDelivery(params: {
  handoff: SetupHandoff;
  baseDir?: string;
}): Promise<SetupHandoff | null> {
  const completion = params.handoff.completion;
  if (!completion) {
    return params.handoff;
  }
  const confirmed = await confirmDevicePairSetupCompletionDelivery({
    setupId: completion.setupId,
    deviceId: completion.deviceId,
    ...(params.baseDir ? { baseDir: params.baseDir } : {}),
  });
  return confirmed ? { record: params.handoff.record, completion: confirmed } : null;
}

function broadcastSetupHandoff(
  { handoff, broadcast }: { handoff: SetupHandoff; broadcast: GatewayBroadcastFn },
  deliveryState: "confirmed" | "uncertain",
): void {
  const completion = handoff.completion;
  if (completion?.deliveryState !== deliveryState) {
    return;
  }
  const payload = {
    setupId: completion.setupId,
    deviceId: completion.deviceId,
    ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
    access: completion.access,
    ts: completion.completedAtMs,
  } satisfies DevicePairSetupCompletedEvent;
  // The retained completion owns recovery when a slow operator socket drops this frame.
  broadcast(
    deliveryState === "confirmed"
      ? "device.pair.setup.completed"
      : "device.pair.setup.deliveryUncertain",
    payload,
    { dropIfSlow: true },
  );
}

/** Broadcast the already-committed completion; status reconciliation owns delivery loss. */
export function broadcastSetupHandoffCompletion(params: {
  handoff: SetupHandoff;
  broadcast: GatewayBroadcastFn;
}): void {
  broadcastSetupHandoff(params, "confirmed");
}

/** Tell the operator that replay is blocked but credential delivery is unknown. */
export function broadcastSetupHandoffDeliveryUncertain(params: {
  handoff: SetupHandoff;
  broadcast: GatewayBroadcastFn;
}): void {
  broadcastSetupHandoff(params, "uncertain");
}
