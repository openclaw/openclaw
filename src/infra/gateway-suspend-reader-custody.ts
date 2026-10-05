import type { GatewayReaderReceipt, GatewayReaderRequest } from "../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "./gateway-active-work.js";
import type { GatewaySuspendHandoffOwner } from "./gateway-suspend-coordinator.js";

export type GatewaySuspendReaderCustody = {
  expiresAtMs: number;
  owner: GatewaySuspendHandoffOwner;
  receipt: Promise<GatewayReaderReceipt>;
  snapshot: GatewayActiveWorkSnapshot;
  assertCurrent: () => void;
};

/**
 * The coordinator installs one accepted operation before native joins start.
 * Custody outlives its requesting socket; current requester authority still owns RPC responses.
 */
export function createGatewaySuspendReaderCustody(params: {
  owner: GatewaySuspendHandoffOwner;
  request: GatewayReaderRequest;
  snapshot: GatewayActiveWorkSnapshot;
  getCurrent: () => GatewaySuspendReaderCustody | undefined;
}): GatewaySuspendReaderCustody {
  const { owner, getCurrent } = params;
  const request = structuredClone(params.request);
  const expiresAtMs = request.expiresAtMs;
  const deadlineAtMs = performance.now() + expiresAtMs - Date.now();
  const assertCurrent = () => {
    if (
      getCurrent() !== custody ||
      !owner.isCurrent() ||
      Date.now() >= expiresAtMs ||
      performance.now() >= deadlineAtMs
    ) {
      throw new Error("Gateway reader custody is no longer current");
    }
  };
  const custody: GatewaySuspendReaderCustody = {
    owner,
    expiresAtMs,
    snapshot: params.snapshot,
    assertCurrent,
    receipt: Promise.resolve()
      .then(() => {
        assertCurrent();
        return owner.prepareReader!(request, assertCurrent);
      })
      .then((receipt) => {
        assertCurrent();
        return receipt;
      }),
  };
  return custody;
}
