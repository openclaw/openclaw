import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => await closeStateDatabaseForTest());

it.each(
  (["device", "cloud-node", "ssh"] as const).flatMap((carrier) =>
    (["tunnel", "sync"] as const).flatMap((boundary) =>
      (["live", "revoked", "aborted"] as const).map((authority) => ({
        carrier,
        boundary,
        authority,
      })),
    ),
  ),
)("forwards live $authority authority to $carrier $boundary effects", async (scenario) => {
  const root = tempDirs.make("placement-transport-authority-");
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const harness = createHarness(database, placements);
  const nodeBacked = scenario.carrier !== "ssh";
  const providerId = scenario.carrier === "device" ? "device" : "generic-cloud-node";
  const profileId = scenario.carrier === "device" ? "device:device-1" : "cloud-node";
  if (nodeBacked) {
    const getEnvironment = vi.mocked(harness.environments.get).getMockImplementation()!;
    const binding = { providerId, profileId, nodeDeviceId: "device-1", sshEndpoint: null };
    vi.mocked(harness.environments.get).mockImplementation((id) => {
      const record = getEnvironment(id);
      return record ? { ...record, ...binding } : undefined;
    });
    vi.mocked(harness.environments.createWithRequest).mockResolvedValue({
      ...harness.ready,
      ...binding,
    });
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: {
        nodeId: "device-1",
        connId: "connection-1",
        pairingIdentity: "identity-1",
        pairingGeneration: "generation-1",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: {
          enabled: true,
          capturedExecPolicy: true,
          capacity: { total: 2, available: 2 },
        },
        commands: ["system.run"],
      },
    }));
  }
  let authorized = true;
  const controller = new AbortController();
  const closed = new Error("dispatch transport authority closed");
  const effect = vi.fn();
  const atBoundary = async (authorize?: () => void) => {
    // Exercise the guard actually forwarded by dispatch, after transport preparation yields.
    await Promise.resolve();
    if (scenario.authority === "revoked") {
      authorized = false;
    } else if (scenario.authority === "aborted") {
      controller.abort(closed);
    }
    authorize?.();
    effect();
  };
  const start = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
    if (scenario.boundary === "tunnel") {
      await atBoundary(request.authorize);
    }
    const handle = await start(request);
    const sync = handle.syncWorkspace.bind(handle);
    handle.syncWorkspace = async (syncRequest) => {
      if (scenario.boundary === "sync") {
        await atBoundary(syncRequest.authorize);
      }
      return await sync(syncRequest);
    };
    return handle;
  });
  const dispatching = harness.service.dispatch(
    {
      ...REQUEST,
      ...(nodeBacked
        ? {
            profileId,
            devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
            ...(scenario.carrier === "device"
              ? {
                  deviceId: "device-1",
                  inheritedProfile: {
                    providerId,
                    profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
                  },
                }
              : {}),
          }
        : {}),
    },
    undefined,
    () => {
      if (!authorized) {
        throw closed;
      }
    },
    controller.signal,
  );
  if (scenario.authority === "live") {
    await expect(dispatching).resolves.toMatchObject({ state: "active" });
    expect(effect).toHaveBeenCalledOnce();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  } else {
    await expect(dispatching).rejects.toBe(closed);
    expect(effect).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  }
});
