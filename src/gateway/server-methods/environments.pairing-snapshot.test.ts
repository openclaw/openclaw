import { expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { persistDevicePairingStoreState } from "../../infra/device-pairing-store.js";
import { withPairedDeviceRecords } from "../../infra/device-pairing.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { callEnvironmentMethod, pairedNodeDevice } from "./environments.test-support.js";

it("serves committed environment inventory while a pairing update awaits cleanup", async () => {
  const state = await createOpenClawTestState({ label: "environment-pairing-snapshot" });
  const device = pairedNodeDevice("node-snapshot", {
    displayName: "Committed node",
    sessionHost: true,
    commands: ["system.run"],
  });
  const entered = createDeferred();
  const release = createDeferred();
  let writer: Promise<void> | undefined;
  let inventory: ReturnType<typeof callEnvironmentMethod> | undefined;
  try {
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [device.deviceId]: device } },
      state.stateDir,
      "both",
    );
    await callEnvironmentMethod("environments.list", {}, { connectedNodes: [] });
    writer = withPairedDeviceRecords(state.stateDir, async (devices) => {
      entered.resolve();
      await release.promise;
      devices[device.deviceId] = pairedNodeDevice(device.deviceId, {
        displayName: "Updated node",
        sessionHost: true,
        commands: ["system.run"],
      });
      return { value: undefined, persist: true };
    });
    await entered.promise;
    inventory = callEnvironmentMethod("environments.list", {}, { connectedNodes: [] });
    const [ok, payload] = await withTestTimeout(
      inventory,
      5_000,
      "environment inventory waited for the pairing writer",
    );
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      environments: expect.arrayContaining([
        {
          id: "node:node-snapshot",
          type: "node",
          label: "Committed node",
          status: "unavailable",
          sessionHost: true,
          trust: "persistent",
          capabilities: ["system.run"],
        },
      ]),
    });
    release.resolve();
    await writer;
    const [updatedOk, updated] = await callEnvironmentMethod(
      "environments.list",
      {},
      { connectedNodes: [] },
    );
    expect(updatedOk).toBe(true);
    expect(updated).toMatchObject({
      environments: expect.arrayContaining([
        expect.objectContaining({ id: "node:node-snapshot", label: "Updated node" }),
      ]),
    });
  } finally {
    release.resolve();
    await Promise.allSettled([writer, inventory]);
    await state.cleanup();
  }
});
