// Gateway-owned Control UI root lifecycle and background asset preparation.
import fs from "node:fs";
import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  inspectControlUiRootAssets,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  getGatewayRestartDrainSignal,
  runOutsideGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createControlUiAssetRetention,
  type ControlUiAssetRetention,
} from "./control-ui-asset-retention.js";
import type {
  ControlUiFileRead,
  ControlUiFileSnapshot,
  ControlUiPreparedFile,
  ControlUiRootAsset,
} from "./control-ui-file.js";
import { isControlUiCompressibleAsset } from "./control-ui-static.js";

export type ControlUiRootState =
  | {
      kind: "bundled";
      path: string;
      realPath?: string;
      retainedAssets?: ControlUiAssetRetention;
      publicAssetBuildId?: string;
    }
  | { kind: "resolved"; path: string; realPath?: string }
  | { kind: "invalid"; path: string }
  | { kind: "preparing" }
  // The document route is unauthenticated; build diagnostics stay in Gateway logs.
  | { kind: "failed" }
  | { kind: "missing" };

type ReadyRoot = Extract<ControlUiRootState, { path: string; kind: "bundled" | "resolved" }>;
type RootFiles = {
  controller: AbortController;
  pending: Map<string, Promise<ControlUiRootAsset | null>>;
  cached: Map<string, { asset: ControlUiRootAsset; bytes: number }>;
  bytes: number;
};
type FileRuntime = {
  pool?: WorkerTaskPool<ControlUiFileRead, ControlUiFileSnapshot | null>;
  roots: WeakMap<ControlUiRootState, RootFiles>;
};
const MAX_PREPARED_BYTES = 96 * 1024 * 1024;
const MAX_PREPARED_ENTRIES = 2_048;

function fileRuntime() {
  return resolveGlobalSingleton<FileRuntime>(
    Symbol.for("openclaw.controlUiRootFiles"),
    () => ({ roots: new WeakMap() }),
    async (runtime) => {
      const pool = runtime.pool;
      runtime.pool = undefined;
      runtime.roots = new WeakMap();
      await pool?.close();
    },
  );
}

function rootFiles(runtime: FileRuntime, root: ControlUiRootState): RootFiles {
  let files = runtime.roots.get(root);
  if (!files) {
    files = { controller: new AbortController(), pending: new Map(), cached: new Map(), bytes: 0 };
    runtime.roots.set(root, files);
  }
  return files;
}

/** Bundled bytes belong to this root generation; custom roots only share concurrent reads. */
export function readControlUiRootAsset(
  root: ReadyRoot,
  fileRel: string,
  readBody: boolean,
): Promise<ControlUiRootAsset | null> {
  const runtime = fileRuntime();
  const owner = rootFiles(runtime, root);
  owner.controller.signal.throwIfAborted();
  const key = `${readBody ? "body" : "metadata"}:${fileRel}`;
  const cachedKey = owner.cached.has(`body:${fileRel}`) ? `body:${fileRel}` : key;
  const cached = owner.cached.get(cachedKey);
  if (cached) {
    owner.cached.delete(cachedKey);
    owner.cached.set(cachedKey, cached);
    return Promise.resolve(cached.asset);
  }
  const pending =
    owner.pending.get(key) ?? (!readBody ? owner.pending.get(`body:${fileRel}`) : undefined);
  if (pending) {
    return pending;
  }
  const pool = (runtime.pool ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeProcessEntrypointUrl("controlUiFile"),
    maxWorkers: 2,
    sharedCompute: true,
    maxPendingTasks: 2_048,
    maxPendingBytes: 8 * 1024 * 1024,
  }));
  const read = async (
    input: Omit<ControlUiFileRead, "readBody">,
  ): Promise<ControlUiPreparedFile | null> => {
    const file = await pool.run(
      { ...input, readBody },
      {
        signal: owner.controller.signal,
        inputBytes:
          2 * (input.rootPath.length + (input.rootRealPath?.length ?? 0) + input.filePath.length),
      },
    );
    return (
      file && {
        ...file,
        body:
          file.body && Buffer.from(file.body.buffer, file.body.byteOffset, file.body.byteLength),
      }
    );
  };
  const preparation = (async (): Promise<ControlUiRootAsset | null> => {
    let location = {
      rootPath: root.path,
      rootRealPath: root.realPath,
      filePath: path.resolve(root.path, fileRel),
      rejectHardlinks: root.kind !== "bundled",
    };
    let file = await read(location);
    if (!file && root.kind === "bundled" && fileRel.startsWith("assets/")) {
      const retained = root.retainedAssets?.resolveAsset(fileRel);
      if (retained) {
        location = { ...retained, rootPath: retained.rootRealPath, rejectHardlinks: true };
        file = await read(location);
      }
    }
    if (!file) {
      return null;
    }
    const asset: ControlUiRootAsset = { file };
    if (
      root.kind === "bundled" &&
      fileRel.startsWith("assets/") &&
      isControlUiCompressibleAsset(fileRel)
    ) {
      const sourcePath = file.path;
      const sidecar = (suffix: string) =>
        read({ ...location, filePath: `${sourcePath}${suffix}` }).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        );
      [asset.br, asset.gzip] = await Promise.all([sidecar(".br"), sidecar(".gz")]);
    }
    owner.controller.signal.throwIfAborted();
    if (root.kind === "bundled" && !(asset.br instanceof Error) && !(asset.gzip instanceof Error)) {
      const bytes =
        (file.body?.byteLength ?? 0) +
        (asset.br?.body?.byteLength ?? 0) +
        (asset.gzip?.body?.byteLength ?? 0);
      if (bytes <= MAX_PREPARED_BYTES) {
        owner.cached.set(key, { asset, bytes });
        owner.bytes += bytes;
        while (owner.bytes > MAX_PREPARED_BYTES || owner.cached.size > MAX_PREPARED_ENTRIES) {
          const oldest = owner.cached.entries().next().value;
          if (!oldest) {
            break;
          }
          owner.cached.delete(oldest[0]);
          owner.bytes -= oldest[1].bytes;
        }
      }
    }
    return asset;
  })().finally(() => owner.pending.delete(key));
  owner.pending.set(key, preparation);
  return preparation;
}

type GatewayControlUiRootParams = {
  controlUiRootOverride?: string;
  controlUiEnabled: boolean;
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
};

export type GatewayControlUiRootLifecycle = {
  state: ControlUiRootState;
  setEnabled: (enabled: boolean) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function resolveAutoRoot(): string | null {
  return resolveControlUiRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
}

function prepareResolvedRootState({
  root,
  configured = false,
  publicAssetBuildId,
  log,
}: {
  root: string;
  configured?: boolean;
  publicAssetBuildId?: string;
  log: GatewayControlUiRootParams["log"];
}): ControlUiRootState {
  try {
    const bundled =
      !configured &&
      isPackageProvenControlUiRootSync(root, {
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
    const resolvedRoot = { path: root, realPath: fs.realpathSync(root) };
    return bundled
      ? {
          kind: "bundled",
          ...resolvedRoot,
          publicAssetBuildId,
          retainedAssets: createControlUiAssetRetention(root),
        }
      : { kind: "resolved", ...resolvedRoot };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Control UI assets are unavailable at ${root}: ${detail}`;
    log.warn(`gateway: ${message}`);
    return configured ? { kind: "invalid", path: path.resolve(root) } : { kind: "failed" };
  }
}

/** Prepare the stable root reference shared by every HTTP listener. */
export function createGatewayControlUiRootLifecycle(
  params: GatewayControlUiRootParams,
): GatewayControlUiRootLifecycle {
  const expectedBuildId = resolveRuntimeServiceBuildId();
  let state: ControlUiRootState = { kind: "preparing" };
  if (params.controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
    const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
    if (!resolvedOverride) {
      params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
      state = { kind: "invalid", path: resolvedOverridePath };
    } else {
      state = prepareResolvedRootState({
        root: resolvedOverride,
        configured: true,
        log: params.log,
      });
    }
  } else if (params.controlUiEnabled) {
    const resolvedRoot = resolveAutoRoot();
    const assets = resolvedRoot ? inspectControlUiRootAssets(resolvedRoot, expectedBuildId) : null;
    state =
      resolvedRoot && assets?.kind === "ready"
        ? prepareResolvedRootState({
            root: resolvedRoot,
            publicAssetBuildId: assets.publicAssetBuildId,
            log: params.log,
          })
        : { kind: "preparing" };
  }

  let enabled = params.controlUiEnabled;
  let stopped = false;
  let preparation: { controller: AbortController; promise: Promise<void> } | undefined;
  const prepare = async (signal: AbortSignal): Promise<void> => {
    const isStopped = () => stopped || signal.aborted;
    if (isStopped()) {
      return;
    }
    try {
      if (state.kind === "preparing") {
        // Initially disabled gateways discover assets only when enabled. Reuse a
        // finished build after cancellation without reviving its retired preparer.
        const resolvedRoot = resolveAutoRoot();
        let assets = resolvedRoot
          ? inspectControlUiRootAssets(resolvedRoot, expectedBuildId)
          : null;
        if (assets?.kind !== "ready") {
          const result = await ensureControlUiAssetsBuilt(params.gatewayRuntime, {
            assetRoot: resolvedRoot ?? undefined,
            expectedBuildId,
            moduleUrl: import.meta.url,
            signal,
          });
          if (isStopped()) {
            return;
          }
          if (!result.ok) {
            Object.assign(state, { kind: "failed" });
            params.log.warn(`gateway: ${result.message}`);
            return;
          }
          assets = result.assets;
        }
        // Listeners retain this object from before bind; replacing it would strand
        // their routes in the preparing state after a successful background build.
        Object.assign(
          state,
          prepareResolvedRootState({
            root: path.dirname(assets.indexPath),
            publicAssetBuildId: assets.publicAssetBuildId,
            log: params.log,
          }),
        );
      }
    } catch (error) {
      if (!isStopped()) {
        Object.assign(state, { kind: "failed" });
        const detail = error instanceof Error ? error.message : String(error);
        params.log.warn(`gateway: Control UI assets build failed: ${detail}`);
      }
      return;
    }
    if (state.kind === "bundled") {
      await state.retainedAssets?.prepare({ signal }).catch((error: unknown) => {
        if (isStopped()) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        params.log.warn(`gateway: Control UI asset retention failed: ${detail}`);
      });
    }
  };
  const start = (): Promise<void> => {
    if (!enabled || stopped) {
      return Promise.resolve();
    }
    if (preparation) {
      return preparation.controller.signal.aborted
        ? preparation.promise.then(start)
        : preparation.promise;
    }
    const controller = new AbortController();
    // Root drain precedes sidecar.stop; cancel preparation before that wait.
    // Capture the current generation on each start, including re-enabled dashboards.
    const signal = AbortSignal.any([controller.signal, getGatewayRestartDrainSignal()]);
    const promise = runOutsideGatewayRootWorkAdmission(() =>
      Promise.resolve().then(() => prepare(signal)),
    ).finally(() => {
      preparation = undefined;
    });
    preparation = { controller, promise };
    return promise;
  };

  return {
    state,
    start,
    setEnabled: (nextEnabled) => {
      if (stopped || enabled === nextEnabled) {
        return;
      }
      enabled = nextEnabled;
      if (enabled) {
        if (state.kind === "failed") {
          Object.assign(state, { kind: "preparing" });
        }
        void start();
      } else {
        preparation?.controller.abort();
      }
    },
    stop: async () => {
      stopped = true;
      preparation?.controller.abort();
      await preparation?.promise;
      // Retire even an unused root: a late HTTP handler must not start its first read after stop.
      const files = rootFiles(fileRuntime(), state);
      files.controller.abort();
      await Promise.allSettled(files.pending.values());
      files.cached.clear();
      files.bytes = 0;
    },
  };
}
