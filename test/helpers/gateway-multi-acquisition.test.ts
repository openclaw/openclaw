import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import "../../src/test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "./promise.js";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("./gateway-e2e-harness.js");
  vi.doUnmock("./openclaw-test-instance.js");
  vi.resetModules();
});

async function createAcquiredOwner() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("acquired owner did not bind");
  }
  let joined = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= promisify(server.close.bind(server))().then(() => {
      joined = true;
    }));
  return { port: address.port, close, isJoined: () => joined };
}

function gateway(
  owner: Awaited<ReturnType<typeof createAcquiredOwner>>,
  stop = owner.close,
  hookToken = "synthetic-hook",
) {
  return { port: owner.port, hookToken, stopGateway: stop, cleanup: stop };
}

function captureSuite() {
  const bodies = new Map<string, () => Promise<void>>();
  const cleanups: Array<() => Promise<void>> = [];
  vi.doMock("vitest", () => ({
    afterAll: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
    describe: (_name: string, run: () => void) => run(),
    it: (name: string, _options: unknown, run: () => Promise<void>) => bodies.set(name, run),
    expect,
  }));
  return { bodies, cleanups };
}

function mockHarness(
  spawn: () => unknown,
  connect: () => unknown,
  status: () => unknown = vi.fn(),
) {
  // mock-isolation: Own acquisition and cleanup failures without spawning real Gateway processes.
  vi.doMock("./gateway-e2e-harness.js", () => ({
    spawnGatewayInstance: spawn,
    stopGatewayInstance: (instance: { cleanup: () => Promise<void> }) => instance.cleanup(),
    postJson: async () => ({ status: 200, json: { ok: true } }),
    connectNode: connect,
    waitForNodeStatus: vi.fn(),
    connectGatewayStatusClient: status,
  }));
}
const acquisitionName = "spins up two gateways and exercises WS + HTTP + node pairing";
const passiveName = "preserves scheduler runtime across a scheduler-disabled Gateway edit";
const outcome = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

it.each(["none", "gateway", "both"] as const)(
  "stops every acquired Gateway and preserves state ownership (cleanup failure: %s)",
  async (failure) => {
    const clientFails = failure === "both";
    const gatewayFails = failure === "gateway" || failure === "both";
    const owners = await Promise.all(Array.from({ length: 3 }, () => createAcquiredOwner()));
    const clientError = new Error("client close failed");
    const gatewayError = new Error("Gateway close failed");
    const bodyError = new Error("scheduler setup failed");
    const events: string[] = [];
    const heldClient = createDeferred();
    const clientStarted = createDeferred();
    const instances = owners.map((owner, index) => {
      const stopGateway = async () => {
        events.push(`stop-${index}`);
        await owner.close();
        if (gatewayFails && index !== 1) {
          throw gatewayError;
        }
      };
      return {
        ...gateway(owner, stopGateway),
        state: { writeAuthProfiles: async () => {} },
        startGateway: async () => {},
        cleanup: async () => {
          await stopGateway();
          events.push(`remove-state-${index}`);
        },
      };
    });
    const stopClient = async () => {
      clientStarted.resolve();
      await heldClient.promise;
      events.push("client-settled");
      if (clientFails) {
        throw clientError;
      }
    };
    const { bodies, cleanups } = captureSuite();
    let nextInstance = 0;
    mockHarness(
      async () => instances[nextInstance++],
      async () => ({
        nodeId: "synthetic-node",
        client: { stopAndWait: stopClient },
      }),
      async () => ({
        request: async () => {
          throw bodyError;
        },
        stopAndWait: stopClient,
      }),
    );
    vi.doMock("./openclaw-test-instance.js", () => ({
      createOpenClawTestInstance: async () => instances[2],
    }));
    let passive: Promise<unknown> | undefined;
    let cleanup: Promise<unknown> | undefined;
    try {
      await import("../gateway.multi.e2e.test.js");
      await bodies.get(acquisitionName)!();
      // The second body fails before spawning its scheduler but still owns a Gateway.
      passive = outcome(bodies.get(passiveName)!());
      await clientStarted.promise;
      expect(events).toEqual([]);
      heldClient.resolve();
      const passiveError = await passive;
      const cleanupError = await (cleanup = outcome(cleanups[0]!()));
      expect(events.filter((event) => event.startsWith("stop-"))).toEqual([
        "stop-2",
        "stop-0",
        "stop-1",
      ]);
      expect(owners.every((owner) => owner.isJoined())).toBe(true);
      expect(events.filter((event) => event.startsWith("remove-state-"))).toEqual(
        clientFails
          ? []
          : gatewayFails
            ? ["remove-state-1"]
            : ["remove-state-2", "remove-state-0", "remove-state-1"],
      );
      const errors = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
      expect(errors(passiveError)).toContain(bodyError);
      for (const error of [passiveError, cleanupError]) {
        if (clientFails) {
          expect(errors(error)).toContain(clientError);
        }
        if (gatewayFails) {
          expect(errors(error)).toContain(gatewayError);
        }
      }
      if (failure === "none") {
        expect(passiveError).toBe(bodyError);
        expect(cleanupError).toBeUndefined();
      }
    } finally {
      heldClient.resolve();
      await passive;
      await cleanup;
      await Promise.all(owners.map((owner) => owner.close()));
    }
  },
);

it.each(["server", "node"] as const)(
  "retains the %s acquired after rejection through actual afterAll",
  async (boundary) => {
    const owner = await createAcquiredOwner();
    const acquisitionError = new Error(`${boundary} acquisition failed`);
    const sibling = createDeferred();
    const failure = createDeferred<never>();
    const started = createDeferred();
    const resource =
      boundary === "server"
        ? gateway(owner)
        : {
            nodeId: "synthetic-node",
            client: {
              stop: () => {
                void owner.close();
              },
              stopAndWait: owner.close,
            },
          };
    const siblingAcquisition = sibling.promise.then(() => resource);
    // Observe both promises before injecting rejection, even if the suite drops them.
    const acquisitions = Promise.allSettled([siblingAcquisition, failure.promise]);
    const servers = ["synthetic-a", "synthetic-b"].map((hookToken) =>
      gateway(owner, async () => {}, hookToken),
    );
    const { bodies, cleanups } = captureSuite();
    let acquisitionCount = 0;
    const acquire = () => {
      if (++acquisitionCount === 1) {
        return siblingAcquisition;
      }
      started.resolve();
      return failure.promise;
    };
    let serverIndex = 0;
    mockHarness(
      boundary === "server" ? acquire : async () => servers[serverIndex++],
      boundary === "node" ? acquire : vi.fn(),
    );
    vi.doMock("./openclaw-test-instance.js", () => ({
      createOpenClawTestInstance: () => {
        throw new Error("unselected suite must not start a Gateway");
      },
    }));
    let bodyResult: Promise<unknown> | undefined;
    let cleanupResult: Promise<unknown> | undefined;
    try {
      // Exercise the real suite's acquisition ordering and teardown registry.
      await import("../gateway.multi.e2e.test.js");
      bodyResult = outcome(bodies.get(acquisitionName)!());
      await started.promise;
      failure.reject(acquisitionError);
      await setImmediate();
      let cleanupSettled = false;
      let ownerJoinedAtCleanupSettlement = false;
      cleanupResult = outcome(cleanups[0]!()).then((error) => {
        ownerJoinedAtCleanupSettlement = owner.isJoined();
        cleanupSettled = true;
        return error;
      });
      await setImmediate();
      const cleanupSettledBeforeLateAcquisition = cleanupSettled;
      sibling.resolve();
      await acquisitions;
      const bodyError = await bodyResult;
      const cleanupError = await cleanupResult;
      expect(bodyError).toBe(acquisitionError);
      expect(cleanupError).toBeUndefined();
      expect(cleanupSettledBeforeLateAcquisition).toBe(false);
      expect(ownerJoinedAtCleanupSettlement).toBe(true);
    } finally {
      // Retain native handles even if the actual suite loses its cleanup reference.
      sibling.resolve();
      failure.reject(acquisitionError);
      await acquisitions;
      await bodyResult;
      await cleanupResult;
      await owner.close();
    }
  },
);
