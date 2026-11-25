import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";
import { portalNodeProof } from "./portal-node-carrier.test-support.js";

const fixture = usePlacementStoreFixture();
afterEach(clearRuntimeConfigSnapshot);

it.each(
  (["device", "cloud-node", "ssh"] as const).flatMap((carrier) =>
    (["tunnel", "sync"] as const).flatMap((boundary) =>
      (["live", "revoked", "aborted"] as const).map(
        (authority) => [carrier, boundary, authority] as const,
      ),
    ),
  ),
)("forwards %s %s authority to transport effects (%s)", async (carrier, boundary, authority) => {
  setRuntimeConfigSnapshot({});
  const { environments, ready, service, placements } = await createHarness(
    fixture.database,
    fixture.store,
  );
  const nodeBacked = carrier !== "ssh";
  const providerId = carrier === "device" ? "device" : "generic-cloud-node";
  const profileId = carrier === "device" ? "device:device-1" : "cloud-node";
  if (nodeBacked) {
    const getEnvironment = vi.mocked(environments.get).getMockImplementation()!;
    const binding = { providerId, profileId, nodeDeviceId: "device-1", sshEndpoint: null };
    vi.mocked(environments.get).mockImplementation((id) => {
      const record = getEnvironment(id);
      return record ? { ...record, ...binding } : undefined;
    });
    vi.mocked(environments.createWithRequest).mockResolvedValue({ ...ready, ...binding });
    bindDeviceWorkerAvailability(environments, async () => ({
      available: true,
      node: {
        ...portalNodeProof("device-1"),
        connId: "connection-1",
        workerHost: {
          enabled: true,
          capturedExecPolicy: true,
          promptContext: 1,
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
    if (authority === "revoked") {
      authorized = false;
    } else if (authority === "aborted") {
      controller.abort(closed);
    }
    authorize?.();
    effect();
  };
  const start = vi.mocked(environments.startTunnel).getMockImplementation()!;
  vi.mocked(environments.startTunnel).mockImplementation(async (request) => {
    if (boundary === "tunnel") {
      await atBoundary(request.authorize);
    }
    const handle = await start(request);
    const sync = handle.syncWorkspace.bind(handle);
    handle.syncWorkspace = async (syncRequest) => {
      if (boundary === "sync") {
        await atBoundary(syncRequest.authorize);
      }
      return await sync(syncRequest);
    };
    return handle;
  });
  const request: typeof REQUEST = { ...REQUEST };
  if (nodeBacked) {
    request.profileId = profileId;
    request.devicePlacement = { requiredNodeCommands: [], consumesWorkerSlot: true };
  }
  if (carrier === "device") {
    request.deviceId = "device-1";
    request.inheritedProfile = {
      providerId,
      profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
    };
  }
  const dispatching = service.dispatch(
    request,
    undefined,
    () => {
      if (!authorized) {
        throw closed;
      }
    },
    controller.signal,
  );
  const live = authority === "live";
  if (live) {
    await expect(dispatching).resolves.toMatchObject({ state: "active" });
  } else {
    await expect(dispatching).rejects.toBe(closed);
    expect(placements.current()).toMatchObject({ state: "failed" });
  }
  expect(effect).toHaveBeenCalledTimes(live ? 1 : 0);
  expect(environments.destroy).toHaveBeenCalledTimes(live ? 0 : 1);
});
