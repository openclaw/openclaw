/** Tests the Gateway-owned Control UI root and background asset lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
const retentionMocks = vi.hoisted(() => ({
  prepare: vi.fn<(options?: { signal?: AbortSignal }) => Promise<void>>(async () => {}),
  resolveAsset: vi.fn(async () => null),
}));

vi.mock("../infra/control-ui-assets.js", () => controlUiAssetsMocks);
vi.mock("../version.js", () => ({ resolveRuntimeServiceBuildId: () => "gateway-build" }));
vi.mock("./control-ui-asset-retention.js", () => ({
  createControlUiAssetRetention: vi.fn(() => retentionMocks),
}));

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
    retentionMocks.prepare.mockResolvedValue(undefined);
    retentionMocks.resolveAsset.mockResolvedValue(null);
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

  test("cancels retained-generation preparation without warning during shutdown", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    retentionMocks.prepare.mockImplementationOnce(
      async (options) =>
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const { lifecycle, warn } = createLifecycle();
    const preparing = lifecycle.start();
    await vi.waitFor(() => expect(retentionMocks.prepare).toHaveBeenCalledOnce());
    await Promise.all([preparing, lifecycle.stop()]);

    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["retention", "build"] as const)(
    "cancels %s during Gateway drain while retaining its cleanup root across generations",
    async (phase) => {
      if (phase === "retention") {
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
        controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
      }
      const { lifecycle, warn } = createLifecycle();
      const rootReference = lifecycle.state;
      try {
        for (let generation = 0; generation < 2; generation++) {
          resetGatewayWorkAdmission();
          const cleanup = createDeferred();
          let preparationSignal: AbortSignal | undefined;
          const prepare = async (signal: AbortSignal | undefined) => {
            preparationSignal = signal;
            await cleanup.promise;
            signal?.throwIfAborted();
          };
          if (phase === "retention") {
            retentionMocks.prepare.mockImplementationOnce((options) => prepare(options?.signal));
          } else {
            controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(
              async (_runtime, options) => {
                await prepare(options.signal);
                return { ok: true, built: true, assets: readyAssets() };
              },
            );
          }
          const work = runWithGatewayIndependentRootWorkAdmission(
            lifecycle.start,
            "startup:sidecars.control-ui-assets",
          );
          try {
            await vi.waitFor(() => expect(preparationSignal).toBeDefined());
            expect(preparationSignal?.aborted).toBe(false);
            expect(getActiveGatewayRootWorkCount()).toBe(1);
            markGatewayRestartDraining();
            expect(preparationSignal?.aborted).toBe(true);
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(getActiveGatewayRootWorkCount()).toBe(1);
          } finally {
            cleanup.resolve();
            await work;
          }
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(lifecycle.state).toBe(rootReference);
          expect(lifecycle.state.kind).toBe(phase === "retention" ? "bundled" : "preparing");
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        await lifecycle.stop();
        resetGatewayWorkAdmission();
      }
    },
  );

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
      retainedAssets: retentionMocks,
    });
    expect(retentionMocks.prepare).toHaveBeenCalledOnce();
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

  test("reports disappearing auto-detected roots without aborting Gateway startup", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: root vanished");
    });

    const { lifecycle, warn } = createLifecycle();

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith(
      "gateway: Control UI assets are unavailable at /repo/dist/control-ui: ENOENT: root vanished",
    );
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

  test("publishes structured build failures into the existing root reference", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: false,
      built: false,
      message: "Control UI build timed out.",
    });
    const { lifecycle, warn } = createLifecycle();
    const rootReference = lifecycle.state;

    await lifecycle.start();

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI build timed out.");
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
