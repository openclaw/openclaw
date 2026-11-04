import { afterEach, describe, expect, it, vi } from "vitest";
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
  return createNodeWorkerBundleTestNode({
    nodeId,
    connId: `conn-${nodeId}`,
    workerHost: bundlePrewarm === undefined ? {} : { bundlePrewarm },
  });
}

function installRequest(current: NodeWorkerSupervisorNodeProof) {
  return {
    deviceId: current.nodeId,
    environmentId: "environment-1",
    reason: "provision" as const,
    artifact,
    prewarm: true,
  };
}

function installerFixture(
  invoke: NodeWorkerSupervisorTransport["invoke"],
  nodes: NodeWorkerSupervisorNodeProof[],
  listCurrentNodes: NodeWorkerSupervisorTransport["listCurrentNodes"] = async () => nodes,
  hasCurrentRunner = false,
) {
  const transfer = createNodeWorkerBundleTransferService();
  const log = { info: vi.fn(), warn: vi.fn() };
  const changed = vi.fn();
  const transport: NodeWorkerSupervisorTransport = {
    hasCurrentRunner: () => hasCurrentRunner,
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((candidate) => candidate.nodeId === nodeId);
    },
    listCurrentNodes,
    isCurrent: (candidate) => nodes.includes(candidate),
    invoke,
  };
  const ensure = createGatewayNodeWorkerBundleInstaller({
    gatewayNamespace: "gateway-test",
    getTransport: () => transport,
    transfer,
    log,
    ...(hasCurrentRunner ? { onObservationChange: changed } : {}),
  });
  return { ensure, transfer, log, changed };
}

function observedInstaller() {
  let clock = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
  const { ensure, transfer, log, changed } = installerFixture(invoke, [node], undefined, true);
  const prefix = "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa";
  return {
    ensure,
    log,
    changed,
    expectLastInfo: (message: string) =>
      expect(log.info).toHaveBeenLastCalledWith(`${prefix} ${message}`),
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    async start(
      reason: "provision" | "refresh" = "refresh",
      environmentId = "environment-1",
      onProgress?: () => void,
    ) {
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
        ...(onProgress ? { onProgress } : {}),
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
  afterEach(() => vi.restoreAllMocks());
  it.each([false, true])(
    "negotiates archive-only prefetch while preserving session install (supported=%s)",
    async (supported) => {
      const current = nodeProof("node-prefetch", 1);
      if (supported) {
        current.workerHost.bundlePrefetch = 1;
      }
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
        ok: true,
        payload: receipt,
      }));
      const { ensure } = installerFixture(invoke, [current]);
      const pending = ensure({ deviceId: current.nodeId, artifact, reason: "prefetch" });
      if (supported) {
        await expect(pending).resolves.toEqual(receipt);
        expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ prefetch: 1 });
        expect(invoke.mock.calls[0]?.[0].params).not.toHaveProperty("bundlePrewarm");
      } else {
        await expect(pending).rejects.toThrow("does not support bundle prefetch");
        expect(invoke).not.toHaveBeenCalled();
      }
      await expect(ensure(installRequest(current))).resolves.toEqual(receipt);
      expect(invoke.mock.lastCall?.[0].params).not.toHaveProperty("prefetch");
    },
  );

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

    // First progress, throttled progress, timed publication, throttled progress, completion.
    for (const [elapsed, bytes, notices, logs] of [
      [500, 1_000_000, 2, 1],
      [1_500, 2_000_000, 2, 1],
      [28_500, 3_000_000, 3, 2],
      [500, 3_500_000, 3, 2],
      [0, 4_000_000, 4, 3],
    ] as const) {
      h.advance(elapsed);
      call.progress(bytes);
      expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
        transferredBytes: bytes,
        phase: bytes === 4_000_000 ? "installing" : "transferring",
      });
      expect(h.changed).toHaveBeenCalledTimes(notices);
      expect(h.log.info).toHaveBeenCalledTimes(logs);
    }
    expect(h.log.info.mock.calls[1]).toEqual([
      "worker runtime install: node=node-1 bundle=aaaaaaaaaaaa 3.0/4.0 MB (75%) 100.0 KB/s",
    ]);
    expect(h.ensure.readInstall(node.nodeId)?.updatedAtMs).toBe(32_000);
    h.expectLastInfo("transfer complete after 30.5s; node is installing");
    call.succeed();
    await call.pending;
    expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    expect(h.changed).toHaveBeenCalledTimes(5);
    expect(h.changed).toHaveBeenLastCalledWith(node.nodeId, ["environment-1"]);
    expect(h.ensure.version()).toBe(7);
    h.expectLastInfo("installed in 31.0s");
  });

  it("refcounts each environment sharing an install until its callers settle", async () => {
    const h = observedInstaller();
    const provisionProgress = vi.fn();
    const refreshProgress = vi.fn();
    const duplicateProgress = vi.fn();
    const provision = await h.start("provision", "environment-1", provisionProgress);
    const duplicate = await h.start("refresh", "environment-1", duplicateProgress);
    expect(duplicateProgress).toHaveBeenCalledOnce();
    const refresh = await h.start("refresh", "environment-2", refreshProgress);
    expect(provisionProgress).toHaveBeenCalled();
    expect(refreshProgress).toHaveBeenCalled();
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
    provisionProgress.mockClear();
    refreshProgress.mockClear();
    duplicate.fail(new Error("caller cancelled"));
    await expect(duplicate.pending).rejects.toThrow("caller cancelled");
    // A settled caller stops hearing the shared transfer; a remaining caller still does.
    expect(provisionProgress).not.toHaveBeenCalled();
    expect(refreshProgress).toHaveBeenCalledOnce();
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
      h.expectLastInfo("transfer restarted");
      if (nextServe === "queued") {
        provision.fail(new Error("transfer interrupted"));
        await expect(provision.pending).rejects.toThrow("transfer interrupted");
      }
      expect(h.ensure.readInstall(node.nodeId)?.transferredBytes).toBe(100_000);

      h.advance(30_000);
      refresh.progress(3_000_000);
      h.expectLastInfo("3.0/4.0 MB (75%) 100.0 KB/s");
      expect(
        h.log.info.mock.calls.filter(([message]) => message.includes("transfer restarted")),
      ).toHaveLength(1);
      h.advance(10_000);
      refresh.progress(4_000_000);
      expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
        transferredBytes: 4_000_000,
        phase: "installing",
      });
      h.expectLastInfo("transfer complete after 40.0s; node is installing");
      refresh.succeed();
      await refresh.pending;
      expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    },
  );

  it.each(["discovery", "dispatch"])("cancels installation during %s", async (phase) => {
    const discovered = createDeferredCore<NodeWorkerSupervisorNodeProof[]>();
    const controller = new AbortController();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return { ok: true, payloadJSON: JSON.stringify(receipt) };
    });
    const listCurrentNodes = vi.fn(() =>
      phase === "discovery" ? discovered.promise : Promise.resolve([node]),
    );
    const { ensure, transfer } = installerFixture(invoke, [node], listCurrentNodes);
    const grant = vi.spyOn(transfer, "prepare");
    const pending = ensure({ ...installRequest(node), signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    try {
      expect(listCurrentNodes).toHaveBeenCalledOnce();
      if (phase === "discovery") {
        controller.abort(new DOMException("Stop node discovery", "AbortError"));
        expect(await outcome).toMatchObject({ name: "AbortError" });
        expect(grant).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
      } else {
        await expect(pending).rejects.toThrow("no longer current");
      }
    } finally {
      discovered.resolve([node]);
      await outcome;
      grant.mockRestore();
      transfer.closeAll();
    }
    if (phase === "discovery") {
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["matching", 1],
    ["matching", undefined],
    ["mismatched", 1],
  ] as const)("binds installation to an exact %s receipt (prewarm=%s)", async (mode, prewarm) => {
    const current = nodeProof("receipt-node", prewarm);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({
        ...receipt,
        bundleHash: mode === "matching" ? artifact.bundleHash : "c".repeat(64),
      }),
    }));
    const { ensure, transfer } = installerFixture(invoke, [current]);
    try {
      const pending = ensure(installRequest(current));
      if (mode === "mismatched") {
        await expect(pending).rejects.toThrow("mismatched build receipt");
      } else {
        await expect(pending).resolves.toEqual(receipt);
      }
      expect(ensure.readInstall(current.nodeId)).toBeUndefined();
      const request = invoke.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        node: current,
        command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
        params: { gatewayNamespace: "gateway-test" },
        idempotencyKey: `gateway-test:${artifact.bundleHash}`,
      });
      if (prewarm) {
        expect(request?.params).toMatchObject({ bundlePrewarm: 1 });
      } else {
        expect(request?.params).not.toHaveProperty("bundlePrewarm");
      }
      const input = request?.params as NodeWorkerBundleInstallInput;
      expect(input.build).toEqual(receipt);
      expect(
        transfer.authorize({ token: input.archive.token, artifactKey: artifact.bundleHash }),
      ).toBeUndefined();
    } finally {
      transfer.closeAll();
    }
  });
  it.each([
    ["same", undefined, "resolves"],
    ["different", "generation-2", "rejects"],
  ] as const)(
    "%s pairing authority on a replacement connection",
    async (_mode, pairingGeneration, outcome) => {
      const replacement = {
        ...node,
        connId: "conn-2",
        ...(pairingGeneration ? { pairingGeneration } : {}),
      };
      const nodes = [node];
      const { ensure, transfer } = installerFixture(async () => {
        nodes[0] = replacement;
        return { ok: true, payloadJSON: JSON.stringify(receipt) };
      }, nodes);
      try {
        const pending = ensure(installRequest(node));
        if (outcome === "resolves") {
          await expect(pending).resolves.toEqual(receipt);
        } else {
          await expect(pending).rejects.toThrow("connection is no longer current");
        }
      } finally {
        transfer.closeAll();
      }
    },
  );
});
