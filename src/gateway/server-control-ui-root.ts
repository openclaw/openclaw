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
import { getOrCreatePromise } from "../shared/lazy-promise.js";
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
type PreparedRepresentation = { asset: ControlUiRootAsset; selected: ControlUiPreparedFile };
type RootFiles = {
  controller: AbortController;
  cacheEnabled: boolean;
  pending: Map<string, Promise<ControlUiRootAsset | null>>;
  reading: Map<string, Promise<PreparedRepresentation | null>>;
  cached: LruCache<PreparedRepresentation>;
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
      pending: new Map(),
      reading: new Map(),
      cached: new LruCache(MAX_PREPARED_ENTRIES, {
        maxBytes: MAX_PREPARED_BYTES,
        sizeOf: (entry) => entry.selected.body?.byteLength ?? 0,
      }),
    };
    runtime.roots.set(root, files);
  }
  return files;
}

function sameFile(a: ControlUiPreparedFile, b: ControlUiPreparedFile): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
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
  const representationKey = (encoding: HttpRepresentationEncoding) => `${encoding}:${fileRel}`;
  const sourceKey = representationKey("identity");
  const knownSource = owner.cached.peek(sourceKey);
  // Only a confirmed absence may be skipped. When the client accepts nothing available,
  // the admitted source still proves a 406; a missing source must be checked separately.
  const preferred = preferences.find(
    (encoding) =>
      encoding === "identity" ||
      knownSource?.asset[encoding] !== null ||
      owner.cached.peek(representationKey(encoding)),
  );
  const cached = owner.cached.get(preferred ? representationKey(preferred) : sourceKey);
  if (cached && (!preferred || !readBody || cached.selected.body)) {
    return Promise.resolve(cached.asset);
  }
  const identity = `${preferences.join(",")}:${fileRel}`;
  const key = `${readBody ? "body" : "metadata"}:${identity}`;
  const pending =
    owner.pending.get(key) ?? (!readBody ? owner.pending.get(`body:${identity}`) : undefined);
  if (pending) {
    return pending;
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
  const publish = (
    encoding: HttpRepresentationEncoding,
    selected: ControlUiPreparedFile,
    source: ControlUiPreparedFile,
    retain = true,
  ): PreparedRepresentation => {
    const cacheKey = representationKey(encoding);
    const previous = owner.cached.peek(cacheKey);
    const unchanged =
      previous && sameFile(previous.selected, selected) && sameFile(previous.asset.file, source);
    if (unchanged && (previous.selected === selected || !selected.body)) {
      return previous;
    }
    // A sidecar must not pin identity bytes after the independent identity entry is evicted.
    const { path: sourcePath, size, mtimeMs } = source;
    const asset =
      encoding === "identity"
        ? { ...(unchanged && previous.asset), file: selected }
        : { file: { path: sourcePath, size, mtimeMs }, [encoding]: selected };
    const entry = { asset, selected };
    if (
      retain &&
      root.kind === "bundled" &&
      owner.cacheEnabled &&
      (selected.body?.byteLength ?? 0) <= MAX_PREPARED_BYTES
    ) {
      owner.cached.set(cacheKey, entry);
    }
    return entry;
  };
  const read = (
    input: Omit<ControlUiFileRead, "readBody">,
    encoding: HttpRepresentationEncoding,
    includeBody: boolean,
    source?: ControlUiPreparedFile,
  ): Promise<PreparedRepresentation | null> => {
    const cacheKey = representationKey(encoding);
    const candidate = source && owner.cached.get(cacheKey);
    if (
      source &&
      candidate &&
      sameFile(candidate.asset.file, source) &&
      (!includeBody || candidate.selected.body)
    ) {
      return Promise.resolve(candidate);
    }
    // Only identical physical reads share work. A metadata read cannot hold up a GET or a different encoding.
    const work = `${cacheKey}:${input.filePath}`;
    const bodyKey = `body:${work}`;
    return (
      (!includeBody && owner.reading.get(bodyKey)) ||
      getOrCreatePromise(
        owner.reading,
        includeBody ? bodyKey : `metadata:${work}`,
        async () => {
          const file = await pool.run(
            { ...input, readBody: includeBody },
            {
              signal: owner.controller.signal,
              inputBytes:
                2 *
                (input.rootPath.length + (input.rootRealPath?.length ?? 0) + input.filePath.length),
            },
          );
          owner.controller.signal.throwIfAborted();
          if (!file) {
            return null;
          }
          const selected = {
            ...file,
            body:
              file.body &&
              Buffer.from(file.body.buffer, file.body.byteOffset, file.body.byteLength),
          };
          return publish(
            encoding,
            selected,
            source && encoding !== "identity" ? source : selected,
            encoding !== "identity" || includeBody || preferences[0] === "identity",
          );
        },
        { evictOnSettled: true },
      )
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
    const source = await read(
      location,
      "identity",
      readBody &&
        !owner.cached.peek(sourceKey)?.selected.body &&
        (preferences[0] === "identity" || knownIdentity),
    );
    if (!source) {
      return null;
    }
    const file = source.selected;
    // Optional variants are sparse. One listing per bundled root generation
    // avoids opening known-absent sidecars; canonical admission still owns every read.
    const assetNames =
      assetDirectory &&
      path.dirname(file.path) === assetDirectory &&
      FINGERPRINTED_ASSET_NAME.test(path.basename(file.path))
        ? (requestedNames ?? (await listAssetNames()))
        : null;
    owner.controller.signal.throwIfAborted();
    for (const encoding of preferences) {
      if (encoding === "identity") {
        return readBody && !file.body
          ? ((await read(location, encoding, true, file))?.asset ?? null)
          : source.asset;
      }
      const sidecarPath = `${file.path}${encoding === "br" ? ".br" : ".gz"}`;
      if (!assetNames || assetNames.has(path.basename(sidecarPath).toLowerCase())) {
        try {
          const result = await read(
            { ...location, filePath: sidecarPath },
            encoding,
            readBody,
            file,
          );
          if (result) {
            return result.asset;
          }
        } catch (error) {
          owner.controller.signal.throwIfAborted();
          return { file, [encoding]: error instanceof Error ? error : new Error(String(error)) };
        }
      }
      // Pin absent variants to the admitted source, without spending an LRU slot per missing file.
      publish("identity", file, file).asset[encoding] = null;
    }
    return publish("identity", file, file).asset;
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
      await Promise.allSettled(files.pending.values());
      files.cached.clear();
    },
  };
}
