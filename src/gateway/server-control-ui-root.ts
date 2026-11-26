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
import type { HttpRepresentationEncoding } from "../infra/http-content-encoding.js";
import { LruCache } from "../infra/lru-cache.js";
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
  isControlUiCompressibleAsset,
  type ControlUiFileRead,
  type ControlUiFileSnapshot,
  type ControlUiPreparedFile,
  type ControlUiRootAsset,
} from "./control-ui-file.js";

export type ControlUiRootState =
  | {
      kind: "bundled";
      path: string;
      realPath?: string;
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
  cacheEnabled: boolean;
  generation: number;
  pending: Map<
    string,
    { preferences: string; readBody: boolean; result: Promise<ControlUiRootAsset | null> }
  >;
  cached: LruCache<{ asset: ControlUiRootAsset; bytes: number }>;
  assetNames?: Promise<Map<string, fs.Dirent> | null>;
};
type FileRuntime = {
  pool?: WorkerTaskPool<ControlUiFileRead, ControlUiFileSnapshot | null>;
  roots: WeakMap<ControlUiRootState, RootFiles>;
};
const MAX_PREPARED_BYTES = 96 * 1024 * 1024;
const MAX_PREPARED_ENTRIES = 2_048;
const FINGERPRINTED_ASSET_NAME = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

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
    files = {
      controller: new AbortController(),
      cacheEnabled: true,
      generation: 0,
      pending: new Map(),
      cached: new LruCache(MAX_PREPARED_ENTRIES, {
        maxBytes: MAX_PREPARED_BYTES,
        sizeOf: (entry) => entry.bytes,
      }),
    };
    runtime.roots.set(root, files);
  }
  return files;
}

function preparedBytes(asset: ControlUiRootAsset): number {
  const { file, br, gzip } = asset;
  return (
    (file.body?.byteLength ?? 0) +
    (br && !(br instanceof Error) ? (br.body?.byteLength ?? 0) : 0) +
    (gzip && !(gzip instanceof Error) ? (gzip.body?.byteLength ?? 0) : 0)
  );
}

function coversControlUiRead(
  asset: ControlUiRootAsset,
  preferences: readonly HttpRepresentationEncoding[],
  readBody: boolean,
): boolean {
  for (const encoding of preferences) {
    const file = encoding === "identity" ? asset.file : asset[encoding];
    // Only an observed absence may be skipped. An unexamined preferred sidecar still needs admission.
    if (file !== null) {
      return !!file && !(file instanceof Error) && (!readBody || !!file.body);
    }
  }
  return true;
}

/** Bundled bytes belong to this root generation; custom roots only share concurrent reads. */
export function readControlUiRootAsset(
  root: ReadyRoot,
  fileRel: string,
  readBody: boolean,
  encodings: readonly HttpRepresentationEncoding[] = ["identity"],
): Promise<ControlUiRootAsset | null> {
  const runtime = fileRuntime();
  const owner = rootFiles(runtime, root);
  owner.controller.signal.throwIfAborted();
  const preferences =
    root.kind === "bundled" &&
    (fileRel === "sw.js" || fileRel.startsWith("assets/")) &&
    isControlUiCompressibleAsset(fileRel)
      ? encodings
      : (["identity"] as const);
  const cached = owner.cached.get(fileRel)?.asset;
  if (cached && coversControlUiRead(cached, preferences, readBody)) {
    return Promise.resolve(cached);
  }
  const generation = owner.generation;
  const key = `${generation}:${fileRel}`;
  const accepted = preferences.join(",");
  const pending = owner.pending.get(key);
  if (pending) {
    if (pending.preferences === accepted && (!readBody || pending.readBody)) {
      return pending.result;
    }
    // A different client can use the same bytes after the active read establishes availability.
    const resume = () => readControlUiRootAsset(root, fileRel, readBody, encodings);
    return pending.result.then(resume, resume);
  }
  const pool = (runtime.pool ??= new WorkerTaskPool({
    workerUrl: resolveRuntimeProcessEntrypointUrl("controlUiFile"),
    workerClass: "file-reader",
    workerOptions: { resourceLimits: { maxYoungGenerationSizeMb: 16 } },
    // Reuse the bounded reader pool across UI visits several minutes apart.
    idleTimeoutMs: 10 * 60_000,
    maxPendingTasks: 2_048,
    maxPendingBytes: 8 * 1024 * 1024,
  }));
  const read = async (
    input: Omit<ControlUiFileRead, "readBody">,
    includeBody: boolean,
  ): Promise<ControlUiPreparedFile | null> => {
    const file = await pool.run(
      { ...input, readBody: includeBody },
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
    const location = {
      rootPath: root.path,
      rootRealPath: root.realPath,
      filePath: path.resolve(root.path, fileRel),
      rejectHardlinks: root.kind !== "bundled",
    };
    const assetDirectory =
      root.kind === "bundled" &&
      owner.cacheEnabled &&
      root.realPath &&
      preferences.length > 0 &&
      preferences[0] !== "identity"
        ? path.join(root.realPath, "assets")
        : undefined;
    const listAssetNames = () =>
      assetDirectory
        ? (owner.assetNames ??= fs.promises
            .readdir(assetDirectory, { withFileTypes: true })
            // Presence remains conservative on case-insensitive filesystems;
            // only an exact ordinary filename can select the initial body read.
            .then((entries) => new Map(entries.map((entry) => [entry.name.toLowerCase(), entry])))
            .catch(() => null))
        : Promise.resolve(null);
    const requestedName = path.basename(fileRel);
    const requestedNames =
      assetDirectory &&
      path.dirname(fileRel) === "assets" &&
      FINGERPRINTED_ASSET_NAME.test(requestedName)
        ? await listAssetNames()
        : null;
    owner.controller.signal.throwIfAborted();
    const requestedEntry = requestedNames?.get(requestedName.toLowerCase());
    const identityIndex = preferences.indexOf("identity");
    const knownIdentity =
      requestedEntry?.name === requestedName &&
      requestedEntry.isFile() &&
      identityIndex >= 0 &&
      preferences
        .slice(0, identityIndex)
        .every(
          (encoding) =>
            !requestedNames?.has(
              `${requestedName}.${encoding === "br" ? "br" : "gz"}`.toLowerCase(),
            ),
        );
    // Pin the source's metadata and canonical path even when serving a sidecar.
    // Known identity-only bundled files need one admitted read for metadata and body.
    const file = await read(
      location,
      readBody && !cached?.file.body && (preferences[0] === "identity" || knownIdentity),
    );
    if (!file) {
      return null;
    }
    owner.controller.signal.throwIfAborted();
    // A newly requested variant still admits the source's canonical path before sharing bytes.
    const unchanged =
      cached &&
      cached.file.path === file.path &&
      cached.file.mtimeMs === file.mtimeMs &&
      cached.file.size === file.size;
    const previous = unchanged ? cached : undefined;
    const asset: ControlUiRootAsset = { file };
    // Optional variants are sparse. One listing per bundled root generation
    // avoids opening known-absent sidecars; canonical admission still owns every read.
    const assetNames =
      assetDirectory &&
      path.dirname(file.path) === assetDirectory &&
      FINGERPRINTED_ASSET_NAME.test(path.basename(file.path))
        ? (requestedNames ?? (await listAssetNames()))
        : null;
    for (const encoding of preferences) {
      if (encoding === "identity") {
        if (previous?.file.body) {
          asset.file = previous.file;
        }
        if (readBody && !asset.file.body) {
          const body = await read(location, true);
          if (!body) {
            return null;
          }
          asset.file = body;
        }
        break;
      }
      const prepared = previous?.[encoding];
      if (
        prepared === null ||
        (prepared && !(prepared instanceof Error) && (!readBody || prepared.body))
      ) {
        asset[encoding] = prepared;
        if (prepared) {
          break;
        }
        continue;
      }
      const sidecarPath = `${file.path}${encoding === "br" ? ".br" : ".gz"}`;
      if (assetNames && !assetNames.has(path.basename(sidecarPath).toLowerCase())) {
        asset[encoding] = null;
        continue;
      }
      const sidecar = await read({ ...location, filePath: sidecarPath }, readBody).catch(
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      asset[encoding] = sidecar;
      // A missing file falls through; the selector owns errors for the chosen encoding.
      if (sidecar) {
        break;
      }
    }
    owner.controller.signal.throwIfAborted();
    if (
      root.kind === "bundled" &&
      owner.cacheEnabled &&
      owner.generation === generation &&
      !(asset.br instanceof Error) &&
      !(asset.gzip instanceof Error)
    ) {
      // Oversized combinations must not displace an individually cacheable selected representation.
      const merged = previous
        ? { ...previous, ...asset, file: asset.file.body ? asset.file : previous.file }
        : asset;
      const retained =
        merged !== asset && preparedBytes(merged) > MAX_PREPARED_BYTES ? asset : merged;
      const bytes = preparedBytes(retained);
      if (bytes <= MAX_PREPARED_BYTES) {
        owner.cached.set(fileRel, { asset: retained, bytes });
        return retained;
      }
    }
    return asset;
  })().finally(() => owner.pending.delete(key));
  owner.pending.set(key, { preferences: accepted, readBody, result: preparation });
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
      // Admitted HTTP reads may finish; only enabled roots cache their results.
      // Stop still joins every outstanding read.
      const files = rootFiles(fileRuntime(), state);
      files.cacheEnabled = enabled;
      files.generation += 1;
      files.cached.clear();
      files.assetNames = undefined;
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
      files.assetNames = undefined;
      await Promise.allSettled(Array.from(files.pending.values(), (read) => read.result));
      files.cached.clear();
    },
  };
}
