import { createMemo, createSignal, type Accessor } from "solid-js";
import {
  currentConfigConnectionEpoch,
  currentConfigRead,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import type { DevicesPageDataState } from "../../lib/nodes/page-operations.ts";
import type { useGatewayPage } from "../../lib/reactive/gateway-page.ts";

export type DevicePolicyRead = { scope: Accessor<unknown>; value: Accessor<void> };

export function createDevicePolicyReads(options: {
  state: Accessor<DevicesPageDataState>;
  config: Accessor<RuntimeConfigState>;
  hasConfig: () => boolean;
  gateway: ReturnType<typeof useGatewayPage>;
  target: () => string;
}) {
  const gateway = options.gateway;
  const scope = createMemo(
    () => ({
      state: options.state(),
      gateway: gateway.gateway,
      epoch: gateway.epoch,
      target: options.target(),
    }),
    {
      equals: (a, b) =>
        a.state === b.state &&
        a.gateway === b.gateway &&
        a.epoch === b.epoch &&
        a.target === b.target,
    },
  );
  const [receipt, setReceipt] = createSignal<{
    state: DevicesPageDataState;
    gateway: typeof gateway.gateway;
    epoch: number;
    target: string;
    result: Promise<unknown>;
  } | null>(null);
  const approvals = createMemo(() => {
    const current = scope();
    const read = receipt();
    return read?.state === current.state &&
      read.gateway === current.gateway &&
      read.epoch === current.epoch &&
      read.target === current.target
      ? read.result.then(() => undefined)
      : Promise.resolve();
  });
  const configScope = createMemo(
    () => {
      const state = options.config();
      return {
        state,
        gateway: gateway.gateway,
        client: gateway.client,
        epoch: gateway.epoch,
        configEpoch: currentConfigConnectionEpoch(state),
      };
    },
    {
      equals: (a, b) =>
        a.state === b.state &&
        a.gateway === b.gateway &&
        a.client === b.client &&
        a.epoch === b.epoch &&
        a.configEpoch === b.configEpoch,
    },
  );
  const config = createMemo(() => {
    const current = configScope();
    const read = currentConfigRead(options.config());
    if (!read || read.client !== current.client || read.connectionEpoch !== current.configEpoch) {
      return Promise.resolve();
    }
    return Promise.race([read.completion.promise, read.invalidated.promise]).then((result) => {
      // A failed reload must preserve the editable last-good bindings and draft.
      if (!result.ok && currentConfigRead(current.state) === read && !options.hasConfig()) {
        throw new Error(result.error);
      }
    });
  });
  return {
    approvals: { scope, value: approvals } satisfies DevicePolicyRead,
    config: { scope: configScope, value: config } satisfies DevicePolicyRead,
    observeApprovals(state: DevicesPageDataState, result: Promise<unknown>) {
      setReceipt({
        state,
        gateway: gateway.gateway,
        epoch: gateway.epoch,
        target: options.target(),
        result,
      });
    },
  };
}
