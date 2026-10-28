import type { GatewayEventFrame } from "../api/gateway.ts";
import {
  closeDevicePairSetup,
  completeDevicePairSetup,
  createDevicePairSetupState,
  markDevicePairSetupDeliveryUncertain,
  openDevicePairSetup,
  parseDevicePairSetupCompletion,
  parseDevicePairSetupDeliveryUncertain,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup,
  setDevicePairSetupAccess,
  syncDevicePairSetupCountdown,
} from "../lib/device-pair-setup.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

const runtime = {
  openDevicePairSetup,
  readDevicePairSetupSnapshot,
  refreshDevicePairSetup,
  setDevicePairSetupAccess,
  syncDevicePairSetupCountdown,
};

export function createOverlayPairing(params: {
  gateway: ApplicationGateway;
  isDisposed: () => boolean;
  publish: () => void;
}) {
  const state = createDevicePairSetupState({
    client: params.gateway.snapshot.client,
    connected: params.gateway.snapshot.phase === "connected",
    onChange: params.publish,
  });
  const { gateway, isDisposed, publish } = params;
  let generation = 0;
  const pendingCount = {
    invalidate(options: { clear?: boolean } = {}) {
      generation += 1;
      if (options.clear) {
        state.pendingCount = 0;
      }
    },

    async refresh() {
      const client = gateway.snapshot.client;
      if (
        !client ||
        gateway.snapshot.phase !== "connected" ||
        isDisposed() ||
        !state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
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
        isDisposed() ||
        requestGeneration !== generation ||
        gateway.snapshot.client !== client ||
        gateway.snapshot.phase !== "connected" ||
        !state.devicePairSetupOpen ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
      ) {
        return;
      }
      state.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
      publish();
    },
  };
  return {
    runtime,
    state,
    pendingCount,
    close(clear = true) {
      pendingCount.invalidate({ clear });
      closeDevicePairSetup(state);
    },
    handleEvent(event: GatewayEventFrame): boolean {
      if (event.event === "device.pair.setup.completed") {
        const completion = parseDevicePairSetupCompletion(event.payload);
        if (completion) {
          completeDevicePairSetup(state, completion);
        }
        return true;
      }
      if (event.event === "device.pair.setup.deliveryUncertain") {
        const outcome = parseDevicePairSetupDeliveryUncertain(event.payload);
        if (outcome) {
          markDevicePairSetupDeliveryUncertain(state, outcome);
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
