import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_PORTAL_STREAM_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_PORTAL_STREAM_VERSION } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { createWorkerNodePortalCarrier } from "./portal-node-carrier.js";
import {
  portalNodeProof,
  fakePortalBroker,
  pendingPortalTransport,
  deferredPortalValue,
} from "./portal-node-carrier.test-support.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("worker node portal carrier", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture(name: string, options: { unbound?: boolean; mutable?: boolean } = {}) {
    const record = await support.seedReadyNodeDesktop(`worker-node-portal-${name}`);
    const state: { record: WorkerEnvironmentRecord | undefined; proofCurrent: boolean } = {
      record,
      proofCurrent: true,
    };
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => state.proofCurrent });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({
      store: options.mutable ? { get: () => state.record } : support.testState.store,
    });
    const bindRuntime = () =>
      carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    if (!options.unbound) {
      bindRuntime();
    }
    const { environmentId, ownerEpoch } = record;
    const open = () => carrier.open({ environmentId, ownerEpoch, remotePort: 4321 });
    const supports = (epoch = ownerEpoch) => carrier.supports(environmentId, epoch);
    return { record, state, proof, transport, streamed, carrier, bindRuntime, open, supports };
  }

  it.each(["discovery", "dispatch"] as const)(
    "rejects resource revocation during %s before node I/O",
    async (stage) => {
      const { proof, transport, open } = await fixture("authority");
      const portal = await open();
      const entered = createDeferred();
      const finish = createDeferred();
      const nodeIo = vi.fn();
      if (stage === "discovery") {
        vi.spyOn(transport.transport, "getCurrentNode").mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return proof;
        });
      } else {
        transport.invoke.mockImplementationOnce(async (request) => {
          entered.resolve();
          await finish.promise;
          if (request.isDispatchAuthorized()) {
            nodeIo();
          }
          return { ok: false, error: { code: "REVOKED", message: "resource revoked" } };
        });
      }
      let authorized = true;
      const connection = portal.connect(() => {
        if (!authorized) {
          throw new Error("resource revoked");
        }
      });
      await entered.promise;
      authorized = false;
      finish.resolve();
      await expect(connection).rejects.toThrow("resource revoked");
      expect(nodeIo).not.toHaveBeenCalled();
      expect(transport.invoke).toHaveBeenCalledTimes(stage === "dispatch" ? 1 : 0);
      await portal.close();
    },
  );

  it("advertises only current node placements with the versioned portal stream capability", async () => {
    const { record, state, proof, transport, bindRuntime, open, supports } = await fixture(
      "capability",
      { unbound: true, mutable: true },
    );
    await expect(supports()).resolves.toBe(false);
    bindRuntime();
    await expect(supports()).resolves.toBe(true);
    await expect(supports(record.ownerEpoch + 1)).resolves.toBe(false);

    proof.workerHost.portalStream = undefined;
    await expect(supports()).resolves.toBe(false);
    await expect(open()).rejects.toThrow("reconnect or update the worker node, then retry");
    proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
    state.proofCurrent = false;
    await expect(supports()).resolves.toBe(false);
    state.record = undefined;
    await expect(supports()).resolves.toBe(false);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("destroys an attached stream when its owner retires while recording activity", async () => {
    const { transport, streamed, open } = await fixture("touch");
    const portal = await open();
    const invoked = createDeferred();
    const originalInvoke = transport.invoke.getMockImplementation()!;
    transport.invoke.mockImplementation((request) => {
      invoked.resolve();
      return originalInvoke(request);
    });
    let current = true;
    const connection = portal.connect(
      () => {
        if (!current) {
          throw new Error("owner retired");
        }
      },
      async () => {
        current = false;
      },
    );
    await invoked.promise;
    const stream = streamed.attachNext();
    await expect(connection).rejects.toThrow("owner retired");
    expect(stream.destroyed).toBe(true);
    await portal.close();
  });

  it("opens one ticketed node duplex per portal connection and closes its owned streams", async () => {
    const { transport, streamed, open } = await fixture("streams");
    const portal = await open();
    expect(transport.invoke).not.toHaveBeenCalled();

    const firstConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    const firstStream = streamed.attachNext();
    await expect(firstConnection).resolves.toBe(firstStream);

    const secondConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(2));
    const secondStream = streamed.attachNext();
    await expect(secondConnection).resolves.toBe(secondStream);
    expect(transport.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: NODE_WORKER_PORTAL_STREAM_COMMAND,
        params: {
          ticket: "a".repeat(48),
          attachPath: `/node-portal/attach?ticket=${"a".repeat(48)}`,
          port: 4321,
        },
        timeoutMs: 0,
      }),
    );

    await portal.close();
    expect(firstStream.destroyed).toBe(true);
    expect(secondStream.destroyed).toBe(true);
    await expect(portal.connect()).rejects.toThrow(
      "reconnect or update the worker node, then retry",
    );
  });

  it.each([
    ["lease", (record: WorkerEnvironmentRecord) => ({ ...record, leaseId: "lease:replacement" })],
    [
      "node",
      (record: WorkerEnvironmentRecord) => ({ ...record, nodeDeviceId: "node:replacement" }),
    ],
    [
      "epoch",
      (record: WorkerEnvironmentRecord) => ({ ...record, ownerEpoch: record.ownerEpoch + 1 }),
    ],
    ["state", (record: WorkerEnvironmentRecord) => ({ ...record, state: "draining" as const })],
    [
      "destroy intent",
      (record: WorkerEnvironmentRecord) => ({ ...record, destroyRequestedAtMs: 2_000 }),
    ],
  ] as const)("rejects the attached stream when its durable %s changes", async (_name, mutate) => {
    const { record, state, transport, streamed, open } = await fixture(`stale-${_name}`, {
      mutable: true,
    });
    const portal = await open();

    const connection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    state.record = mutate(record);
    const stream = streamed.attachNext();

    await expect(connection).rejects.toThrow("owner changed before attachment");
    expect(stream.destroyed).toBe(true);
    await portal.close();
  });

  it("aborts an owner that is stopped while node discovery is still pending", async () => {
    const { record, transport, carrier, open } = await fixture("pending-discovery");
    const pendingNodes = deferredPortalValue<readonly NodeWorkerSupervisorNodeProof[]>();
    transport.transport.listCurrentNodes = () => pendingNodes.promise;
    const opening = open();
    await carrier.stop(record.environmentId, record.ownerEpoch);

    await expect(opening).rejects.toThrow("owner stopped");
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});
