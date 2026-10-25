/** Tests the Gateway-owned Control UI root and background asset lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareLocalAgentAvatar } from "../agents/identity-avatar-file-runtime.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import { getWorkerComputeCapacity } from "../infra/worker-task-capacity.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";

const controlUiAssetsMocks = vi.hoisted(() => ({
  ensureControlUiAssetsBuilt: vi.fn(),
  isPackageProvenControlUiRootSync: vi.fn(),
  inspectControlUiRootAssets: vi.fn(),
  resolveControlUiRootOverrideSync: vi.fn(),
  resolveControlUiRootSync: vi.fn(),
}));

vi.mock("../infra/control-ui-assets.js", () => controlUiAssetsMocks);
vi.mock("../version.js", () => ({ resolveRuntimeServiceBuildId: () => "gateway-build" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 4,
}));

import type { ControlUiFileSnapshot } from "./control-ui-file.js";
import {
  createGatewayControlUiRootLifecycle,
  readControlUiRootAsset,
} from "./server-control-ui-root.js";

function readyAssets(root = "/repo/dist/control-ui", publicAssetBuildId?: string) {
  return { kind: "ready", indexPath: `${root}/index.html`, publicAssetBuildId };
}

const builtAssets = () => ({ ok: true as const, assets: readyAssets() });
const expectBody = async (read: ReturnType<typeof readControlUiRootAsset>, body: string) =>
  expect(await read).toMatchObject({ file: { body: Buffer.from(body) } });
const enable = async (lifecycle: ReturnType<typeof createGatewayControlUiRootLifecycle>) => {
  lifecycle.setEnabled(true);
  await lifecycle.start();
};
const iconSnapshot = (body?: string, mtimeMs = 1): ControlUiFileSnapshot => ({
  path: "/repo/dist/control-ui/icon.png",
  size: body?.length ?? 0,
  mtimeMs,
  ...(body && { body: Buffer.from(body) }),
});

describe("createGatewayControlUiRootLifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "realpathSync").mockImplementation((rootPath) => String(rootPath));
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue(builtAssets());
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(false);
    controlUiAssetsMocks.inspectControlUiRootAssets.mockImplementation((root) => readyAssets(root));
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(null);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  function createLifecycle(options?: { enabled?: boolean; override?: string }) {
    const warn = vi.fn<(message: string) => void>();
    const lifecycle = createGatewayControlUiRootLifecycle({
      ...(options?.override ? { controlUiRootOverride: options.override } : {}),
      controlUiEnabled: options?.enabled ?? true,
      gatewayRuntime: { log: vi.fn() } as never,
      log: { warn },
    });
    onTestFinished(() => lifecycle.stop());
    return { lifecycle, warn };
  }

  function preparedLifecycle(kind: "resolved" | "bundled") {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(kind === "bundled");
    const { lifecycle } = createLifecycle();
    const root = lifecycle.state;
    if (root.kind !== "resolved" && root.kind !== "bundled") {
      throw new Error(`Expected a ${kind} root`);
    }
    expect(root.kind).toBe(kind);
    return { lifecycle, root };
  }

  test("does not admit a first file read after its root has stopped", async () => {
    const { lifecycle, root } = preparedLifecycle("resolved");
    const read = vi.spyOn(WorkerTaskPool.prototype, "run").mockResolvedValue(null);
    await lifecycle.stop();
    expect(() => readControlUiRootAsset(root, "index.html", true)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  test("drops disabled bundled assets without disturbing another root's cache", async () => {
    const rootPath = tempDirs.make("control-ui-cache-disable-");
    fs.mkdirSync(path.join(rootPath, "assets"));
    const writeAssets = (body: string) =>
      fs.writeFileSync(path.join(rootPath, "assets/app.js"), body);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(rootPath);
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();
    const sibling = createLifecycle().lifecycle;
    const root = lifecycle.state;
    const siblingRoot = sibling.state;
    if (root.kind !== "bundled" || siblingRoot.kind !== "bundled") {
      throw new Error("Expected bundled roots");
    }
    try {
      writeAssets("original");
      const original = await readControlUiRootAsset(root, "assets/app.js", true);
      await readControlUiRootAsset(siblingRoot, "assets/app.js", true);
      writeAssets("changed");
      lifecycle.setEnabled(false);
      await expectBody(readControlUiRootAsset(root, "assets/app.js", true), "changed");
      writeAssets("reenabled");
      await enable(lifecycle);
      const refreshed = await readControlUiRootAsset(root, "assets/app.js", true);
      await expectBody(Promise.resolve(refreshed), "reenabled");
      expect(await readControlUiRootAsset(root, "assets/app.js", false)).toBe(refreshed);
      expect(await readControlUiRootAsset(siblingRoot, "assets/app.js", true)).toEqual(original);
    } finally {
      await Promise.all([lifecycle.stop(), sibling.stop()]);
      await drainGlobalSingletonLifecycleState();
    }
  });

  test("starts fresh caching after a read completes while disabled", async () => {
    const { lifecycle, root } = preparedLifecycle("bundled");
    const oldFile = createDeferred<ControlUiFileSnapshot | null>();
    const newFile = createDeferred<ControlUiFileSnapshot | null>();
    vi.spyOn(WorkerTaskPool.prototype, "run")
      .mockReturnValueOnce(oldFile.promise)
      .mockReturnValueOnce(newFile.promise);
    const oldRead = readControlUiRootAsset(root, "icon.png", true);
    lifecycle.setEnabled(false);
    oldFile.resolve(iconSnapshot("old"));
    await expectBody(oldRead, "old");
    await enable(lifecycle);
    const newRead = readControlUiRootAsset(root, "icon.png", true);
    expect(newRead).not.toBe(oldRead);
    expect(readControlUiRootAsset(root, "icon.png", false)).toBe(newRead);
    newFile.resolve(iconSnapshot("new", 2));
    const refreshed = await newRead;
    await expectBody(Promise.resolve(refreshed), "new");
    expect(await readControlUiRootAsset(root, "icon.png", true)).toBe(refreshed);
  });

  test("joins outstanding reads across enablement changes during stop", async () => {
    const { lifecycle, root } = preparedLifecycle("resolved");
    const file = createDeferred<ControlUiFileSnapshot | null>();
    vi.spyOn(WorkerTaskPool.prototype, "run").mockReturnValueOnce(file.promise);
    const read = readControlUiRootAsset(root, "icon.png", true);
    const rejected = expect(read).rejects.toThrow();
    lifecycle.setEnabled(false);
    await enable(lifecycle);
    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    file.resolve(iconSnapshot());
    await rejected;
    await stop;
    expect(stopped).toBe(true);
  });

  test("reads a cold asset while the shared compute budget is occupied", async () => {
    const root = tempDirs.make("control-ui-compute-contention-");
    fs.writeFileSync(path.join(root, "index.html"), "synthetic asset");
    const capacity = getWorkerComputeCapacity();
    const permits = Array.from({ length: capacity.getSnapshot().limit }, () => {
      const permit = capacity.acquire(
        () => {},
        () => false,
      );
      if (!permit) {
        throw new Error("Expected an unused compute budget");
      }
      return permit;
    });
    const read = readControlUiRootAsset({ kind: "resolved", path: root }, "index.html", true);
    try {
      await expectBody(read, "synthetic asset");
    } finally {
      for (const permit of permits) {
        capacity.release(permit);
      }
      await read;
      await drainGlobalSingletonLifecycleState();
    }
  });

  test.each(["control-ui-file", "identity-avatar-file"])(
    "reuses both %s workers across sparse reads, then releases them after inactivity",
    async (script) => {
      const root = tempDirs.make("sparse-file-reads-");
      const files = ["first.png", "second.png"];
      const source = { kind: "resolved" as const, path: root };
      const starts = () =>
        getTrackedWorkerLifecycleSnapshot().workerLifecycle.find((entry) =>
          entry.script.includes(`${script}.worker`),
        )?.started ?? 0;
      const read = async (file: string) => {
        if (script === "control-ui-file") {
          return (await readControlUiRootAsset(source, file, true))?.file.body;
        }
        const result = await prepareLocalAgentAvatar({
          workspaceDir: root,
          source: file,
          readBody: true,
        });
        return result.ok ? result.file.body : undefined;
      };
      const readPair = () => Promise.all(files.map(read));
      const writePair = (body: string) => {
        for (const file of files) {
          fs.writeFileSync(path.join(root, file), body);
        }
        return files.map(() => Buffer.from(body));
      };
      await drainGlobalSingletonLifecycleState();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const before = starts();
        const first = writePair("first");
        expect(await readPair()).toEqual(first);
        expect(starts() - before).toBe(2);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        const changed = writePair("second image");
        expect(await readPair()).toEqual(changed);
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        expect(await readPair()).toEqual(changed);
        expect(starts() - before).toBe(2);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(await readPair()).toEqual(changed);
        expect(starts() - before).toBe(4);
      } finally {
        await drainGlobalSingletonLifecycleState();
        vi.useRealTimers();
      }
    },
  );

  test("cancels builds during Gateway drain while retaining its cleanup root across generations", async () => {
    const { lifecycle, warn } = createLifecycle();
    const rootReference = lifecycle.state;
    try {
      for (let generation = 0; generation < 2; generation++) {
        resetGatewayWorkAdmission();
        const cleanup = createDeferred();
        const started = createDeferred<AbortSignal>();
        controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(
          async (_runtime, options) => {
            started.resolve(options.signal);
            await cleanup.promise;
            options.signal.throwIfAborted();
            return builtAssets();
          },
        );
        const work = runWithGatewayIndependentRootWorkAdmission(
          lifecycle.start,
          "startup:sidecars.control-ui-assets",
        );
        try {
          const preparationSignal = await started.promise;
          expect(preparationSignal.aborted).toBe(false);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          markGatewayRestartDraining();
          expect(preparationSignal.aborted).toBe(true);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
        } finally {
          cleanup.resolve();
          await work;
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(lifecycle.state).toBe(rootReference);
        expect(lifecycle.state.kind).toBe("preparing");
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      await lifecycle.stop();
      resetGatewayWorkAdmission();
    }
  });

  test.each([false, true])("keeps invalid configured roots terminal (vanished: %s)", (vanished) => {
    const configuredRoot = path.resolve(vanished ? "/custom/ui" : "/custom/missing");
    if (vanished) {
      controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(configuredRoot);
      vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
        throw new Error("ENOENT: root vanished");
      });
    }
    const { lifecycle, warn } = createLifecycle({ override: configuredRoot });
    expect(lifecycle.state).toEqual({ kind: "invalid", path: configuredRoot });
    expect(warn).toHaveBeenCalledWith(
      vanished
        ? `gateway: Control UI assets are unavailable at ${configuredRoot}: ENOENT: root vanished`
        : `gateway: controlUi.root not found at ${configuredRoot}`,
    );
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("prepares initially disabled assets when enabled and keeps the serving root stable", async () => {
    const { lifecycle } = createLifecycle({ enabled: false });
    const rootReference = lifecycle.state;

    await lifecycle.start();
    expect(controlUiAssetsMocks.resolveControlUiRootSync).not.toHaveBeenCalled();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    await enable(lifecycle);
    expect(lifecycle.state).toBe(rootReference);
    expect(lifecycle.state).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test.each(["shutdown", "re-enable"])(
    "retires an interrupted build before %s without publishing its late result",
    async (action) => {
      const shutdown = action === "shutdown";
      if (shutdown) {
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
        vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
          throw new Error("root unavailable");
        });
      }
      const { lifecycle, warn } = createLifecycle();
      if (shutdown) {
        expect(lifecycle.state).toEqual({ kind: "failed" });
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
        lifecycle.setEnabled(false);
        warn.mockClear();
      }
      const result = createDeferred<ReturnType<typeof builtAssets>>();
      controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValueOnce(result.promise);
      lifecycle.setEnabled(true);
      const first = lifecycle.start();
      await vi.waitFor(() =>
        expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
      );
      const signal = controlUiAssetsMocks.ensureControlUiAssetsBuilt.mock.calls[0]?.[1].signal;
      let second: Promise<void>;
      if (shutdown) {
        second = lifecycle.stop();
      } else {
        lifecycle.setEnabled(false);
        second = enable(lifecycle);
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
      }
      expect(signal.aborted).toBe(true);
      expect(lifecycle.state).toEqual({ kind: "preparing" });
      result.resolve(builtAssets());
      await Promise.all([first, second]);
      expect(lifecycle.state).toMatchObject(
        shutdown ? { kind: "preparing" } : { kind: "resolved", path: "/repo/dist/control-ui" },
      );
      expect(warn).not.toHaveBeenCalled();
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
      await lifecycle.stop();
      lifecycle.setEnabled(false);
      await enable(lifecycle);
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    },
  );

  test.each([false, true])(
    "reports a failed build and retries on re-enable (throws: %s)",
    async (throws) => {
      const build = controlUiAssetsMocks.ensureControlUiAssetsBuilt;
      if (throws) {
        build.mockRejectedValueOnce(new Error("spawn failed"));
      } else {
        build.mockResolvedValueOnce({ ok: false, message: "build failed" });
      }
      const { lifecycle, warn } = createLifecycle();
      const rootReference = lifecycle.state;
      await lifecycle.start();
      expect(rootReference).toEqual({ kind: "failed" });
      expect(warn).toHaveBeenCalledWith(
        throws ? "gateway: Control UI assets build failed: spawn failed" : "gateway: build failed",
      );

      lifecycle.setEnabled(false);
      controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
      await enable(lifecycle);
      expect(lifecycle.state).toBe(rootReference);
      expect(rootReference).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    },
  );
});
