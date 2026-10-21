/** Tests the Gateway-owned Control UI root and background asset lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

describe("createGatewayControlUiRootLifecycle", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "realpathSync").mockImplementation((rootPath) => String(rootPath));
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: true,
      built: false,
      assets: readyAssets(),
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(false);
    controlUiAssetsMocks.inspectControlUiRootAssets.mockImplementation((root) => readyAssets(root));
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(null);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createLifecycle(options?: {
    enabled?: boolean;
    override?: string;
    warn?: ReturnType<typeof vi.fn<(message: string) => void>>;
  }) {
    const gatewayRuntime = { log: vi.fn() };
    const warn = options?.warn ?? vi.fn<(message: string) => void>();
    const lifecycle = createGatewayControlUiRootLifecycle({
      ...(options?.override ? { controlUiRootOverride: options.override } : {}),
      controlUiEnabled: options?.enabled ?? true,
      gatewayRuntime: gatewayRuntime as never,
      log: { warn },
    });
    return { lifecycle, warn };
  }

  test("does not admit a first file read after its root has stopped", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    const { lifecycle } = createLifecycle();
    const root = lifecycle.state;
    if (root.kind !== "resolved") {
      throw new Error("Expected a prepared root");
    }
    const read = vi.spyOn(WorkerTaskPool.prototype, "run").mockResolvedValue(null);
    await lifecycle.stop();
    expect(() => readControlUiRootAsset(root, "index.html", true)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  test("drops disabled bundled assets without disturbing another root's cache", async () => {
    const rootPath = tempDirs.make("control-ui-cache-disable-");
    fs.mkdirSync(path.join(rootPath, "assets"));
    const writeAssets = (body: string) => {
      for (const suffix of ["", ".br", ".gz"]) {
        fs.writeFileSync(path.join(rootPath, `assets/app.js${suffix}`), body + suffix);
      }
    };
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
      // A request admitted before the hot reload may reach the reader afterwards.
      expect(await readControlUiRootAsset(root, "assets/app.js", true)).toMatchObject({
        file: { body: Buffer.from("changed") },
      });
      writeAssets("reenabled");
      lifecycle.setEnabled(true);
      await lifecycle.start();
      const refreshed = await readControlUiRootAsset(root, "assets/app.js", true);
      expect(refreshed).toMatchObject({
        file: { body: Buffer.from("reenabled") },
      });
      expect(await readControlUiRootAsset(root, "assets/app.js", false)).toBe(refreshed);
      expect(await readControlUiRootAsset(siblingRoot, "assets/app.js", true)).toEqual(original);
    } finally {
      await Promise.all([lifecycle.stop(), sibling.stop()]);
      await drainGlobalSingletonLifecycleState();
    }
  });

  test("starts fresh caching after a read completes while disabled", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();
    const root = lifecycle.state;
    if (root.kind !== "bundled") {
      throw new Error("Expected a bundled root");
    }
    const oldFile = createDeferred<ControlUiFileSnapshot | null>();
    const newFile = createDeferred<ControlUiFileSnapshot | null>();
    vi.spyOn(WorkerTaskPool.prototype, "run")
      .mockReturnValueOnce(oldFile.promise)
      .mockReturnValueOnce(newFile.promise);
    const oldRead = readControlUiRootAsset(root, "icon.png", true);
    lifecycle.setEnabled(false);
    oldFile.resolve({
      path: "/repo/dist/control-ui/icon.png",
      size: 3,
      mtimeMs: 1,
      body: Buffer.from("old"),
    });
    await expect(oldRead).resolves.toMatchObject({ file: { body: Buffer.from("old") } });
    lifecycle.setEnabled(true);
    await lifecycle.start();
    const newRead = readControlUiRootAsset(root, "icon.png", true);
    expect(newRead).not.toBe(oldRead);
    // Completion while disabled must not refill the cache.
    expect(readControlUiRootAsset(root, "icon.png", false)).toBe(newRead);
    newFile.resolve({
      path: "/repo/dist/control-ui/icon.png",
      size: 3,
      mtimeMs: 2,
      body: Buffer.from("new"),
    });
    const refreshed = await newRead;
    expect(refreshed).toMatchObject({ file: { body: Buffer.from("new") } });
    expect(await readControlUiRootAsset(root, "icon.png", true)).toBe(refreshed);
    await lifecycle.stop();
  });

  test("joins outstanding reads across enablement changes during stop", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    const { lifecycle } = createLifecycle();
    const root = lifecycle.state;
    if (root.kind !== "resolved") {
      throw new Error("Expected a prepared root");
    }
    const file = createDeferred<ControlUiFileSnapshot | null>();
    vi.spyOn(WorkerTaskPool.prototype, "run").mockReturnValueOnce(file.promise);
    const read = readControlUiRootAsset(root, "icon.png", true);
    const rejected = expect(read).rejects.toThrow();
    lifecycle.setEnabled(false);
    lifecycle.setEnabled(true);
    await lifecycle.start();
    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    file.resolve({ path: "/repo/dist/control-ui/icon.png", size: 0, mtimeMs: 1 });
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
    const run = vi.spyOn(WorkerTaskPool.prototype, "run");
    const read = readControlUiRootAsset({ kind: "resolved", path: root }, "index.html", true);
    try {
      const pool = run.mock.contexts[0];
      if (!(pool instanceof WorkerTaskPool)) {
        throw new Error("Expected the file read to reach its worker pool");
      }
      expect(pool.getSnapshot().activeTasks).toBe(1);
      await expect(read).resolves.toMatchObject({ file: { body: Buffer.from("synthetic asset") } });
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

  test("snapshots public asset identity only for a bundled root", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    controlUiAssetsMocks.inspectControlUiRootAssets.mockReturnValue(
      readyAssets("/repo/dist/control-ui", "build-content-digest"),
    );
    const { lifecycle } = createLifecycle();
    expect(lifecycle.state).toMatchObject({
      kind: "bundled",
      publicAssetBuildId: "build-content-digest",
    });
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue("/repo/dist/control-ui");
    const custom = createLifecycle({ override: "/repo/dist/control-ui" });
    expect(custom.lifecycle.state).not.toHaveProperty("publicAssetBuildId");
  });

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
            return { ok: true, built: true, assets: readyAssets() };
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

  test("rebuilds incomplete auto-discovered roots before publishing them", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.inspectControlUiRootAssets.mockReturnValue({ kind: "incomplete" });
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(async () => {
      controlUiAssetsMocks.inspectControlUiRootAssets.mockImplementation((root) =>
        readyAssets(root),
      );
      return { ok: true, built: true, assets: readyAssets() };
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();
    const rootReference = lifecycle.state;

    expect(rootReference).toEqual({ kind: "preparing" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    await lifecycle.start();

    expect(lifecycle.state).toBe(rootReference);
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    expect(rootReference).toEqual({
      kind: "bundled",
      path: "/repo/dist/control-ui",
      realPath: "/repo/dist/control-ui",
    });
  });

  test("keeps invalid configured roots terminal without starting a default build", () => {
    const configuredRoot = path.resolve("/custom/missing");
    const { lifecycle, warn } = createLifecycle({ override: "/custom/missing" });

    expect(lifecycle.state).toEqual({ kind: "invalid", path: configuredRoot });
    expect(warn).toHaveBeenCalledWith(`gateway: controlUi.root not found at ${configuredRoot}`);
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("keeps disappearing configured roots from aborting Gateway startup", () => {
    const configuredRoot = path.resolve("/custom/ui");
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(configuredRoot);
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: root vanished");
    });

    const { lifecycle, warn } = createLifecycle({ override: configuredRoot });

    expect(lifecycle.state).toEqual({ kind: "invalid", path: configuredRoot });
    expect(warn).toHaveBeenCalledWith(
      `gateway: Control UI assets are unavailable at ${configuredRoot}: ENOENT: root vanished`,
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
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(lifecycle.state).toBe(rootReference);
    expect(lifecycle.state).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  test("publishes rejected builds as actionable terminal failures", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockRejectedValue(new Error("spawn failed"));
    const { lifecycle, warn } = createLifecycle();

    await lifecycle.start();

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI assets build failed: spawn failed");
  });

  test("does not publish a late recovery build result after shutdown", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new Error("root unavailable");
    });
    const { lifecycle, warn } = createLifecycle();
    expect(lifecycle.state).toEqual({ kind: "failed" });
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
    lifecycle.setEnabled(false);
    warn.mockClear();
    let finishBuild: (() => void) | undefined;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
      new Promise((resolve) => {
        finishBuild = () => resolve({ ok: true, built: true, assets: readyAssets() });
      }),
    );
    lifecycle.setEnabled(true);
    const build = lifecycle.start();
    await vi.waitFor(() =>
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
    );

    const stopped = lifecycle.stop();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt.mock.calls[0]?.[1].signal.aborted).toBe(
      true,
    );
    finishBuild?.();
    await Promise.all([build, stopped]);

    expect(lifecycle.state).toEqual({ kind: "preparing" });
    expect(warn).not.toHaveBeenCalled();
    lifecycle.setEnabled(false);
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
  });

  test("retires an interrupted build before preparing a re-enabled dashboard", async () => {
    let finishBuild!: () => void;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishBuild = () => resolve({ ok: true, built: true, assets: readyAssets() });
        }),
    );
    const { lifecycle, warn } = createLifecycle();
    const first = lifecycle.start();
    await vi.waitFor(() =>
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
    );
    const signal = controlUiAssetsMocks.ensureControlUiAssetsBuilt.mock.calls[0]?.[1]?.signal;
    lifecycle.setEnabled(false);
    expect(signal.aborted).toBe(true);
    lifecycle.setEnabled(true);
    const second = lifecycle.start();
    expect(lifecycle.state).toEqual({ kind: "preparing" });

    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    finishBuild();
    await Promise.all([first, second]);
    expect(lifecycle.state).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    await lifecycle.stop();
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
  });

  test("retries a failed preparation when the operator re-enables the dashboard", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValueOnce({
      ok: false,
      message: "build failed",
    });
    const { lifecycle } = createLifecycle();
    const rootReference = lifecycle.state;
    await lifecycle.start();
    expect(rootReference).toEqual({ kind: "failed" });

    lifecycle.setEnabled(false);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    await lifecycle.stop();
  });
});
