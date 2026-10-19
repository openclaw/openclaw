import type { GatewayEventFrame } from "../api/gateway.ts";
import * as runtime from "../lib/device-pair-setup.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

type DevicePairSetupState = ReturnType<typeof runtime.createDevicePairSetupState>;

export function createOverlayPairing(params: {
  gateway: ApplicationGateway;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  const state = runtime.createDevicePairSetupState({
    client: params.gateway.snapshot.client,
    connected: params.gateway.snapshot.phase === "connected",
    onChange: params.publish,
  });
  const pendingCount = createOverlayPairingPendingCount({ ...params, state });
  return {
    runtime,
    state,
    pendingCount,
    close(clear = true) {
      pendingCount.invalidate({ clear });
      runtime.closeDevicePairSetup(state);
    },
    handleEvent(event: GatewayEventFrame): boolean {
      if (event.event === "device.pair.setup.completed") {
        const completion = runtime.parseDevicePairSetupCompletion(event.payload);
        if (completion) {
          runtime.completeDevicePairSetup(state, completion);
        }
        return true;
      }
      if (event.event === "device.pair.setup.deliveryUncertain") {
        const outcome = runtime.parseDevicePairSetupDeliveryUncertain(event.payload);
        if (outcome) {
          runtime.markDevicePairSetupDeliveryUncertain(state, outcome);
        }
        return true;
      }
      if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
        void pendingCount.refresh();
        return true;
      }
      return false;
    },
  };
}

function createOverlayPairingPendingCount(params: {
  gateway: ApplicationGateway;
  state: DevicePairSetupState;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  let generation = 0;

  return {
    invalidate(options: { clear?: boolean } = {}) {
      generation += 1;
      if (options.clear) {
        params.state.pendingCount = 0;
      }
    },

    async refresh() {
      const client = params.gateway.snapshot.client;
      if (
        !client ||
        params.gateway.snapshot.phase !== "connected" ||
        params.isDisposed() ||
        !params.state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(params.gateway.snapshot).canAdmin
      ) {
        return;
      }
      const requestGeneration = ++generation;
      let result: { pending?: unknown };
      try {
        result = await client.request<{ pending?: unknown }>("device.pair.list", {});
      } catch {
        return;
      }
      if (
        params.isDisposed() ||
        requestGeneration !== generation ||
        params.gateway.snapshot.client !== client ||
        params.gateway.snapshot.phase !== "connected" ||
        !params.state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(params.gateway.snapshot).canAdmin
      ) {
        return;
      }
      params.state.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
      params.publish();
    },
  };
}
