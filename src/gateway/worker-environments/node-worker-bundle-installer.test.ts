import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  nodes: NodeWorkerSupervisorNodeProof[] = [node],
  listCurrentNodes: NodeWorkerSupervisorTransport["listCurrentNodes"] = async () => nodes,
  options: Partial<Parameters<typeof createGatewayNodeWorkerBundleInstaller>[0]> = {},
) {
  let tokenId = 65;
  const transfer = createNodeWorkerBundleTransferService({
    generateToken: () => String.fromCharCode(tokenId++).repeat(43),
  });
  onTestFinished(() => transfer.closeAll());
  const transport: NodeWorkerSupervisorTransport = {
    hasCurrentRunner: () => false,
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
    log: { info: vi.fn(), warn: vi.fn() },
    ...options,
  });
  return { ensure, transfer, transport };
}

function observedInstaller() {
  let clock = 1_000;
  const log = { info: vi.fn(), warn: vi.fn() };
  const changed = vi.fn();
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
  const { ensure, transfer } = installerFixture(invoke, [node], async () => [node], {
    log,
    now: () => clock,
    onObservationChange: changed,
  });
  return {
    ensure,
    log,
    changed,
    counts: () => ({
      version: ensure.version(),
      changes: changed.mock.calls.length,
      logs: log.info.mock.calls.length,
    }),
    expectInfo: (message: string) =>
      expect(log.info).toHaveBeenLastCalledWith(
        `worker runtime install: node=node-1 bundle=aaaaaaaaaaaa ${message}`,
      ),
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
      const succeed = () => result.resolve({ ok: true, payload: receipt });
      invoke.mockImplementationOnce(async (request) => {
        const input = request.params as NodeWorkerBundleInstallInput;
        dispatched.resolve(
          transfer.authorize({
            token: input.archive.token,
            artifactKey: input.build.bundleHash,
          }),
        );
        return result.promise;
      });
      const pending = ensure({
        ...installRequest(node),
        artifact: { ...artifact, tarballBytes: 4_000_000 },
        reason,
        environmentId,
        ...(onProgress ? { onProgress } : {}),
      });
      const capability = (await dispatched.promise)?.capability;
      if (!capability?.onProgress || !capability.onInterrupted) {
        succeed();
        await pending;
        throw new Error("install did not publish transfer observers");
      }
      return {
        pending,
        progress: capability.onProgress,
        interrupt: capability.onInterrupted,
        succeed,
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
    expect(h.counts()).toMatchObject({ version: 2, changes: 2 });
    h.advance(1_500);
    call.progress(2_000_000);
    expect(h.counts()).toMatchObject({ changes: 2, logs: 1 });
    h.advance(28_500);
    call.progress(3_000_000);
    h.expectInfo("3.0/4.0 MB (75%) 100.0 KB/s");
    h.advance(500);
    call.progress(3_500_000);
    expect(h.counts()).toMatchObject({ logs: 2, changes: 3 });
    call.progress(4_000_000);
    expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
      phase: "installing",
      transferredBytes: 4_000_000,
      updatedAtMs: 32_000,
    });
    expect(h.changed).toHaveBeenCalledTimes(4);
    h.expectInfo("transfer complete after 30.5s; node is installing");
    call.succeed();
    await call.pending;
    expect(h.ensure.readInstall(node.nodeId)).toBeUndefined();
    expect(h.counts()).toMatchObject({ changes: 5, version: 7 });
    expect(h.changed).toHaveBeenLastCalledWith(node.nodeId, ["environment-1"]);
    h.expectInfo("installed in 31.0s");
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
    expect(h.counts()).toMatchObject({ version: version + 1, changes: changes + 1 });
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
      h.expectInfo("transfer restarted");
      if (nextServe === "queued") {
        provision.fail(new Error("transfer interrupted"));
        await expect(provision.pending).rejects.toThrow("transfer interrupted");
      }
      expect(h.ensure.readInstall(node.nodeId)?.transferredBytes).toBe(100_000);

      h.advance(30_000);
      refresh.progress(3_000_000);
      h.expectInfo("3.0/4.0 MB (75%) 100.0 KB/s");
      expect(
        h.log.info.mock.calls.filter(([message]) => message.includes("transfer restarted")),
      ).toHaveLength(1);
      h.advance(10_000);
      refresh.progress(4_000_000);
      expect(h.ensure.readInstall(node.nodeId)).toMatchObject({
        transferredBytes: 4_000_000,
        phase: "installing",
      });
      h.expectInfo("transfer complete after 40.0s; node is installing");
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
    }
    if (phase === "discovery") {
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it.each(["matching", "mismatched"])(
    "binds installation to an exact %s receipt across node capabilities",
    async (mode) => {
      const nodes = [nodeProof("advertising", 1), nodeProof("legacy")];
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
        ok: true,
        payloadJSON: JSON.stringify({
          ...receipt,
          bundleHash: mode === "matching" ? artifact.bundleHash : "c".repeat(64),
        }),
      }));
      const { ensure, transfer } = installerFixture(invoke, nodes);
      for (const [index, current] of nodes.entries()) {
        const pending = ensure(installRequest(current));
        if (mode === "mismatched") {
          await expect(pending).rejects.toThrow("mismatched build receipt");
        } else {
          await expect(pending).resolves.toMatchObject({ bundleHash: artifact.bundleHash });
        }
        expect(ensure.readInstall(current.nodeId)).toBeUndefined();
        expect(ensure.version()).toBe((index + 1) * 2);
        const request = invoke.mock.calls[index]?.[0];
        expect(request).toMatchObject({
          node: current,
          command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
          params: { gatewayNamespace: "gateway-test" },
          idempotencyKey: `gateway-test:${artifact.bundleHash}`,
        });
        if (index === 0) {
          expect(request?.params).toMatchObject({ bundlePrewarm: 1 });
        } else {
          expect(request?.params).not.toHaveProperty("bundlePrewarm");
        }
        const input = request?.params as NodeWorkerBundleInstallInput;
        expect(input.build).toEqual(receipt);
        expect(
          transfer.authorize({ token: input.archive.token, artifactKey: artifact.bundleHash }),
        ).toBeUndefined();
      }
    },
  );
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
      let current = node;
      const { ensure, transport } = installerFixture(
        async () => {
          current = replacement;
          return { ok: true, payloadJSON: JSON.stringify(receipt) };
        },
        [node],
        async () => [current],
      );
      transport.isCurrent = (candidate) => candidate === current;
      const pending = ensure(installRequest(node));
      if (outcome === "resolves") {
        await expect(pending).resolves.toEqual(receipt);
      } else {
        await expect(pending).rejects.toThrow("connection is no longer current");
      }
    },
  );
});
