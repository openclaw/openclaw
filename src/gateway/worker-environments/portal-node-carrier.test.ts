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

  it.each(["discovery", "dispatch"] as const)(
    "rejects resource revocation during %s before node I/O",
    async (stage) => {
      const record = await support.seedReadyNodeDesktop("worker-node-portal-authority");
      const proof = portalNodeProof(record.nodeDeviceId!);
      const transport = pendingPortalTransport({ proof, isProofCurrent: () => true });
      const streamed = fakePortalBroker();
      const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
      carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
      const portal = await carrier.open({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        remotePort: 4321,
      });
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
    const record = await support.seedReadyNodeDesktop("worker-node-portal-capability");
    let current: WorkerEnvironmentRecord | undefined = record;
    let proofCurrent = true;
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => proofCurrent });
    const carrier = createWorkerNodePortalCarrier({ store: { get: () => current } });

    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    carrier.bindRuntime({
      transport: transport.transport,
      streamBroker: fakePortalBroker().broker,
    });
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(true);
    await expect(carrier.supports(record.environmentId, record.ownerEpoch + 1)).resolves.toBe(
      false,
    );

    proof.workerHost.portalStream = undefined;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    await expect(
      carrier.open({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        remotePort: 4321,
      }),
    ).rejects.toThrow("reconnect or update the worker node, then retry");
    proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
    proofCurrent = false;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    current = undefined;
    await expect(carrier.supports(record.environmentId, record.ownerEpoch)).resolves.toBe(false);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it.each(["touch rejects", "owner retires"] as const)(
    "destroys an attached stream when %s while recording activity",
    async (failure) => {
      const record = await support.seedReadyNodeDesktop("worker-node-portal-touch");
      const transport = pendingPortalTransport({
        proof: portalNodeProof(record.nodeDeviceId!),
        isProofCurrent: () => true,
      });
      const streamed = fakePortalBroker();
      const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
      carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
      const portal = await carrier.open({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        remotePort: 4321,
      });
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
          if (failure === "touch rejects") {
            throw new Error("activity update failed");
          }
          current = false;
        },
      );
      await invoked.promise;
      const stream = streamed.attachNext();
      await expect(connection).rejects.toThrow(
        failure === "touch rejects" ? "activity update failed" : "owner retired",
      );
      expect(stream.destroyed).toBe(true);
      await portal.close();
    },
  );

  it("opens one ticketed node duplex per portal connection and closes its owned streams", async () => {
    const record = await support.seedReadyNodeDesktop("worker-node-portal-streams");
    const proof = portalNodeProof(record.nodeDeviceId!);
    const transport = pendingPortalTransport({ proof, isProofCurrent: () => true });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });
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
    const record = await support.seedReadyNodeDesktop(`worker-node-portal-stale-${_name}`);
    let current: WorkerEnvironmentRecord | undefined = record;
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: { get: () => current } });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });

    const connection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    current = mutate(record) as WorkerEnvironmentRecord;
    const stream = streamed.attachNext();

    await expect(connection).rejects.toThrow("owner changed before attachment");
    expect(stream.destroyed).toBe(true);
    await portal.close();
  });

  it("destroys a disconnected node stream while retaining the portal for a new connection", async () => {
    const record = await support.seedReadyNodeDesktop("worker-node-portal-reconnect");
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const streamed = fakePortalBroker();
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    const portal = await carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });

    const firstConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    const firstStream = streamed.attachNext();
    await firstConnection;
    transport.dropNext();
    await support.waitForFast(() => expect(firstStream.destroyed).toBe(true));

    const recoveredConnection = portal.connect();
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(2));
    const recoveredStream = streamed.attachNext();
    await expect(recoveredConnection).resolves.toBe(recoveredStream);

    await carrier.stop(record.environmentId, record.ownerEpoch);
    expect(recoveredStream.destroyed).toBe(true);
  });

  it("aborts an owner that is stopped while node discovery is still pending", async () => {
    const record = await support.seedReadyNodeDesktop("worker-node-portal-pending-discovery");
    const pendingNodes = deferredPortalValue<readonly NodeWorkerSupervisorNodeProof[]>();
    const transport = pendingPortalTransport({
      proof: portalNodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    transport.transport.listCurrentNodes = () => pendingNodes.promise;
    const carrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    carrier.bindRuntime({
      transport: transport.transport,
      streamBroker: fakePortalBroker().broker,
    });

    const opening = carrier.open({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      remotePort: 4321,
    });
    await carrier.stop(record.environmentId, record.ownerEpoch);

    await expect(opening).rejects.toThrow("owner stopped");
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});
