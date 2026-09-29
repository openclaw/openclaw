import { describe, expect, it, vi } from "vitest";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../../infra/node-commands.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { NodeWorkerBundleInstallInput } from "../../worker/node-bundle-install-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";

const node = createNodeWorkerBundleTestNode();
const artifact = {
  install: "bundle" as const,
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: [],
  tarballBytes: 123,
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/bundle.tgz",
};

const receipt = {
  bundleHash: artifact.bundleHash,
  openclawVersion: artifact.openclawVersion,
  protocolFeatures: artifact.protocolFeatures,
};

function nodeProof(nodeId: string, bundlePrewarm?: 1): NodeWorkerSupervisorNodeProof {
  return {
    ...createNodeWorkerBundleTestNode(),
    nodeId,
    connId: `conn-${nodeId}`,
    workerHost: {
      enabled: true,
      capacity: { total: 2, available: 2 },
      ...(bundlePrewarm === undefined ? {} : { bundlePrewarm: 1 }),
    },
  };
}

function observedInstaller() {
  let clock = 1_000;
  const log = { info: vi.fn(), warn: vi.fn() };
  const changed = vi.fn();
  const transfer = createNodeWorkerBundleTransferService();
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
  const transport: NodeWorkerSupervisorTransport = {
    hasCurrentRunner: () => true,
    getCurrentNode: async (nodeId) => (nodeId === node.nodeId ? node : undefined),
    listCurrentNodes: async () => [node],
    isCurrent: (candidate) => candidate === node,
    invoke,
  };
  const ensure = createGatewayNodeWorkerBundleInstaller({
    gatewayNamespace: "gateway-test",
    getTransport: () => transport,
    transfer,
    log,
    now: () => clock,
    onObservationChange: changed,
  });
  return {
    ensure,
    log,
    changed,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    async start(reason: "provision" | "refresh" = "refresh", environmentId = "environment-1") {
      const dispatched = createDeferredCore<ReturnType<typeof transfer.authorize>>();
      const result =
        createDeferredCore<Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>>();
      invoke.mockImplementationOnce(async (request) => {
        const input = request.params as NodeWorkerBundleInstallInput;
        const capability = transfer.authorize({
          token: input.archive.token,
          artifactKey: input.build.bundleHash,
        });
        dispatched.resolve(capability);
        return result.promise;
      });
      const pending = ensure({
        deviceId: node.nodeId,
        artifact: { ...artifact, tarballBytes: 4_000_000 },
        prewarm: true,
        reason,
        environmentId,
      });
      const capability = (await dispatched.promise)?.capability;
      if (!capability?.onProgress || !capability.onInterrupted) {
        result.resolve({ ok: true, payload: receipt });
        await pending;
        throw new Error("install did not publish transfer observers");
      }
      return {
        pending,
        progress: capability.onProgress,
        interrupt: capability.onInterrupted,
        succeed: () => result.resolve({ ok: true, payload: receipt }),
        fail: (error: Error) => result.reject(error),
      };
    },
  };
}

describe("Gateway node worker bundle installer", () => {
  it("publishes install phases and throttles byte notices and logs with its clock", async () => {
    const h = observedInstaller();
    const call = await h.start();
    expect(h.ensure.readInstall(node.nodeId)).toEqual({
      nodeId: node.nodeId,
      environmentIds: ["environment-1"],
      bundleHash: artifact.bundleHash,
      totalBytes: 4_000_000,
      transferredBytes: 0,
      phase: "transferring",
      startedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    expect(h.ensure.version()).toBe(1);
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(node.nodeId, ["environment-1"]);
    expect(h.log.info).toHaveBeenCalledWith(
      "worker runtime install started (refresh): node=node-1 bundle=aaaaaaaaaaaa size=4.0 MB",
    );

    h.advance(500);
    call.progress(1_000_000);
    expect(h.ensure.readInstall(node.nodeId)).toMatchObject({ transferredBytes: 1_000_000 });
    expect(h.ensure.version()).toBe(2);
    expect(h.changed).toHaveBeenCalledTimes(2);
    h.advance(1_500);
    call.progress(2_000_000);
    expect(h.changed).toHaveBeenCalledTimes(2);
    expect(h.log.info).toHaveBeenCalledTimes(1);
    h.advance(28_500);
    call.progress(3_000_000);
    expect(h.log.info).toHaveBeenLastCalledWith(
      "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa 3.0/4.0 MB (75%) 100.0 KB/s",
    );
    h.advance(500);
    call.progress(3_500_000);
    expect(h.log.info).toHaveBeenCalledTimes(2);
    expect(h.changed).toHaveBeenCalledTimes(3);
    call.progress(4_000_000);
    expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
      phase: "installing",
      transferredBytes: 4_000_000,
      updatedAtMs: 32_000,
    });
    expect(h.changed).toHaveBeenCalledTimes(4);
    expect(h.log.info).toHaveBeenLastCalledWith(
      "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa transfer complete after 30.5s; node is installing",
    );
    call.succeed();
    await call.pending;
    expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    expect(h.changed).toHaveBeenCalledTimes(5);
    expect(h.changed).toHaveBeenLastCalledWith(node.nodeId, ["environment-1"]);
    expect(h.ensure.version()).toBe(7);
    expect(h.log.info).toHaveBeenLastCalledWith(
      "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa installed in 31.0s",
    );
  });

  it("removes failed observations and logs the failure", async () => {
    const h = observedInstaller();
    const call = await h.start("provision");
    h.advance(2_000);
    call.fail(new Error("node connection closed"));
    await expect(call.pending).rejects.toThrow("node connection closed");
    expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    expect(h.ensure.version()).toBe(2);
    expect(h.changed).toHaveBeenCalledTimes(2);
    expect(h.log.warn).toHaveBeenCalledExactlyOnceWith(
      "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa failed after 2.0s: node connection closed",
    );
  });

  it("refcounts each environment sharing an install until its callers settle", async () => {
    const h = observedInstaller();
    const provision = await h.start("provision", "environment-1");
    const duplicate = await h.start("refresh", "environment-1");
    const refresh = await h.start("refresh", "environment-2");
    expect(h.ensure.readInstall(node.nodeId)?.environmentIds).toEqual([
      "environment-1",
      "environment-2",
    ]);
    expect(h.ensure.readInstallForEnvironment("unrelated")).toBeUndefined();
    provision.progress(3_000_000);
    refresh.progress(1_000_000);
    expect(h.ensure.readInstallForEnvironment("environment-1")?.transferredBytes).toBe(1_000_000);
    refresh.progress(4_000_000);
    provision.progress(3_500_000);
    expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
      transferredBytes: 4_000_000,
      phase: "installing",
    });
    provision.succeed();
    await provision.pending;
    expect(h.ensure.readInstallForEnvironment("environment-1")?.phase).toBe("installing");
    const version = h.ensure.version();
    const changes = h.changed.mock.calls.length;
    duplicate.fail(new Error("caller cancelled"));
    await expect(duplicate.pending).rejects.toThrow("caller cancelled");
    expect(h.ensure.readInstallForEnvironment("environment-1")).toBeUndefined();
    expect(h.ensure.readInstall(node.nodeId)?.environmentIds).toEqual(["environment-2"]);
    expect(h.ensure.version()).toBe(version + 1);
    expect(h.changed).toHaveBeenCalledTimes(changes + 1);
    expect(h.changed).toHaveBeenLastCalledWith(node.nodeId, ["environment-2", "environment-1"]);
    expect(h.ensure.readInstallForEnvironment("environment-2")?.phase).toBe("installing");
    refresh.succeed();
    await refresh.pending;
    expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    expect(h.ensure.readInstallForEnvironment("environment-2")).toBeUndefined();
  });

  it.each([
    [3_000_000, "queued"],
    [4_000_000, "queued"],
    [3_000_000, "retry"],
    [4_000_000, "retry"],
  ] as const)(
    "reports an interrupted serve at %i bytes once and immediately publishes %s transfer progress",
    async (interruptedBytes, nextServe) => {
      const h = observedInstaller();
      const provision = await h.start("provision");
      const refresh = nextServe === "queued" ? await h.start("refresh") : provision;
      provision.progress(1_000_000);
      h.advance(90_000);
      provision.progress(interruptedBytes);
      expect(h.ensure.readInstall(node.nodeId)?.phase).toBe(
        interruptedBytes === 4_000_000 ? "installing" : "transferring",
      );
      provision.interrupt(interruptedBytes, "client disconnected");
      provision.interrupt(interruptedBytes, "client disconnected");
      expect(h.log.warn).toHaveBeenCalledExactlyOnceWith(
        `worker runtime install: node=node-1 bundle=aaaaaaaaaaaa transfer interrupted at ${(interruptedBytes / 1_000_000).toFixed(1)}/4.0 MB: client disconnected`,
      );

      const publicationsBeforeRestart = h.changed.mock.calls.length;
      h.advance(500);
      refresh.progress(100_000);
      expect(h.changed).toHaveBeenCalledTimes(publicationsBeforeRestart + 1);
      expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
        transferredBytes: 100_000,
        phase: "transferring",
        startedAtMs: 1_000,
        updatedAtMs: 91_500,
      });
      expect(h.log.info).toHaveBeenLastCalledWith(
        "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa transfer restarted",
      );
      if (nextServe === "queued") {
        provision.fail(new Error("transfer interrupted"));
        await expect(provision.pending).rejects.toThrow("transfer interrupted");
      }
      expect(h.ensure.readInstall(node.nodeId)?.transferredBytes).toBe(100_000);

      h.advance(30_000);
      refresh.progress(3_000_000);
      expect(h.log.info).toHaveBeenLastCalledWith(
        "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa 3.0/4.0 MB (75%) 100.0 KB/s",
      );
      expect(
        h.log.info.mock.calls.filter(([message]) => message.includes("transfer restarted")),
      ).toHaveLength(1);
      h.advance(10_000);
      refresh.progress(4_000_000);
      expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
        transferredBytes: 4_000_000,
        phase: "installing",
      });
      expect(h.log.info).toHaveBeenLastCalledWith(
        "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa transfer complete after 40.0s; node is installing",
      );
      refresh.succeed();
      await refresh.pending;
      expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    },
  );

  it("cancels held node discovery before granting or invoking installation", async () => {
    const discovered = createDeferredCore<NodeWorkerSupervisorNodeProof[]>();
    const controller = new AbortController();
    const transfer = createNodeWorkerBundleTransferService();
    const grant = vi.spyOn(transfer, "prepare");
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payload: artifact,
    }));
    const listCurrentNodes = vi.fn(() => discovered.promise);
    const ensure = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => ({
        hasCurrentRunner: () => false,
        async getCurrentNode(nodeId) {
          return (await this.listCurrentNodes()).find((candidate) => candidate.nodeId === nodeId);
        },
        listCurrentNodes,
        isCurrent: (candidate) => candidate === node,
        invoke,
      }),
      transfer,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const pending = ensure({
      deviceId: node.nodeId,
      environmentId: "environment-1",
      reason: "provision",
      artifact,
      prewarm: true,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      expect(listCurrentNodes).toHaveBeenCalledOnce();
      controller.abort(new DOMException("Stop node discovery", "AbortError"));
      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(grant).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      discovered.resolve([node]);
      await pending;
      grant.mockRestore();
      transfer.closeAll();
    }
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("binds install dispatch to the current node proof and exact receipt", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => "A".repeat(43),
    });
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (_request) => ({
      ok: true,
      payloadJSON: JSON.stringify({
        bundleHash: artifact.bundleHash,
        openclawVersion: artifact.openclawVersion,
        protocolFeatures: artifact.protocolFeatures,
      }),
    }));
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      getCurrentNode: async (nodeId) => (node.nodeId === nodeId ? node : undefined),
      listCurrentNodes: async () => [node],
      isCurrent: (candidate) => candidate === node,
      invoke,
    };
    const ensure = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(
      ensure({
        environmentId: "environment-1",
        reason: "provision",
        deviceId: node.nodeId,
        artifact,
        prewarm: true,
      }),
    ).resolves.toMatchObject({
      bundleHash: artifact.bundleHash,
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        node,
        command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
        params: expect.objectContaining({ gatewayNamespace: "gateway-test" }),
        idempotencyKey: `gateway-test:${artifact.bundleHash}`,
      }),
    );
    const input = invoke.mock.calls[0]?.[0].params as { archive: { token: string } };
    expect(
      transfer.authorize({ token: input.archive.token, artifactKey: artifact.bundleHash }),
    ).toBeUndefined();
  });

  it("rejects a mismatched node receipt", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => "B".repeat(43),
    });
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      getCurrentNode: async (nodeId) => (node.nodeId === nodeId ? node : undefined),
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke: async () => ({
        ok: true,
        payloadJSON: JSON.stringify({
          bundleHash: "c".repeat(64),
          openclawVersion: artifact.openclawVersion,
          protocolFeatures: artifact.protocolFeatures,
        }),
      }),
    };
    const ensure = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(
      ensure({
        environmentId: "environment-1",
        reason: "provision",
        deviceId: node.nodeId,
        artifact,
        prewarm: true,
      }),
    ).rejects.toThrow("mismatched build receipt");
  });

  it("negotiates prewarming independently across a mixed node fleet", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => String.fromCharCode(65 + invoke.mock.calls.length).repeat(43),
    });
    const advertising = nodeProof("advertising", 1);
    const legacy = nodeProof("legacy");
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => ({
      ok: true,
      payloadJSON: JSON.stringify((request.params as { build: typeof artifact }).build),
    }));
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      getCurrentNode: async (nodeId) =>
        [advertising, legacy].find((candidate) => candidate.nodeId === nodeId),
      listCurrentNodes: async () => [advertising, legacy],
      isCurrent: () => true,
      invoke,
    };
    const ensure = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(
      ensure({
        environmentId: "environment-1",
        reason: "provision",
        deviceId: advertising.nodeId,
        artifact,
        prewarm: true,
      }),
    ).resolves.toMatchObject({
      bundleHash: artifact.bundleHash,
    });
    await expect(
      ensure({
        environmentId: "environment-1",
        reason: "provision",
        deviceId: legacy.nodeId,
        artifact,
        prewarm: true,
      }),
    ).resolves.toMatchObject({
      bundleHash: artifact.bundleHash,
    });

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundlePrewarm: 1 });
    expect(invoke.mock.calls[1]?.[0].params).not.toHaveProperty("bundlePrewarm");
  });

  it("keeps explicit cancellation with its request", async () => {
    const controller = new AbortController();
    const transfer = createNodeWorkerBundleTransferService();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return { ok: true, payloadJSON: JSON.stringify(receipt) };
    });
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      getCurrentNode: async (nodeId) => (node.nodeId === nodeId ? node : undefined),
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke,
    };
    const ensure = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(
      ensure({
        deviceId: node.nodeId,
        environmentId: "environment-1",
        reason: "provision",
        artifact,
        prewarm: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("no longer current");
    transfer.closeAll();
  });
});
