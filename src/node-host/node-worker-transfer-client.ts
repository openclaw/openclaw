import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { boundedWorkerError } from "../gateway/worker-environments/worker-error.js";
import {
  replaceWorkerWorkspaceHashMemoEntries,
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import { decodeWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import { absoluteEntryMatches } from "../gateway/worker-environments/workspace-reconcile-fs.js";
import {
  restoreWorkerWorkspaceHistory,
  workerHistoryNotAdopted,
} from "../gateway/worker-environments/workspace-result-history.js";
import { workerWorkspaceTransferPaths } from "../gateway/worker-environments/workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { root as fsRoot, FsSafeError } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  ensureStagedInputDirectory,
  isStagedInputPath,
  stagedInputDirectoriesFromEntries,
} from "../media/staged-inputs.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  boundedWorkspaceTransferChunks,
  readWorkspaceTransferBody as readResponseBody,
} from "../worker/node-workspace-transfer-body.js";
import {
  nodeWorkspaceTransferBlobPath,
  NodeWorkerWorkspaceTransferError,
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferPackPath,
  nodeWorkspaceTransferReconcilePath,
  MAX_WORKSPACE_RESULT_GIT_PACK_BYTES,
  type NodeWorkerWorkspaceTransferInput,
  type NodeWorkerWorkspaceTransferStage,
} from "../worker/node-workspace-transfer-protocol.js";
import {
  prepareNodeWorkerWorkspaceOverlay,
  type NodeWorkerPreparedWorkspaceTransfer,
} from "./node-worker-prepared-workspace-transfer.js";
import {
  applyNodeRepositoryCheckpoint,
  readNodeRepositoryCheckpointBase,
  withNodeRepositoryPublication,
} from "./node-worker-repository-transfers.js";
import {
  requireNodeWorkerTransferOk as requireOk,
  downloadNodeWorkerTransferFile as downloadFile,
  nodeWorkerTransferWorkspacePath as workspacePath,
  NodeWorkerTransferHttpError,
  withNodeWorkerTransferHttpRequest,
  type NodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";
import { createNodeWorkerTempWorkspace } from "./node-worker-workspace-admission.js";
import {
  captureManifest,
  readWorkspaceManifest,
  runWorkspaceCommand,
} from "./node-worker-workspace-commands.js";
import {
  initializeNodeWorkerGitWorkspace,
  prepareNodeWorkerGitResult,
} from "./node-worker-workspace-git.js";
import {
  recoverWorkspaceReplacement,
  replaceNodeWorkerDirectory,
} from "./node-worker-workspace-replacement.js";
import { copyNodeWorkerProjectSeedObjects } from "./node-worker-workspace-seeds.js";

const TRANSFER_RESULT_MAX_BYTES = 64 * 1024;

export type NodeWorkerTransferGateway = {
  url: string;
  tlsFingerprint?: string;
  cloudflareAccess?: CloudflareAccessCredentials;
};

type WorkspaceTransferContext = {
  seedsRoot?: string;
  gatewayNamespace?: string;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: NodeWorkerWorkspaceTransferInput;
  prepared?: NodeWorkerPreparedWorkspaceTransfer;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
};

type WorkspaceTransferOperation<Direction extends NodeWorkerWorkspaceTransferInput["direction"]> =
  Omit<WorkspaceTransferContext, "transfer"> & {
    transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: Direction }>;
    request: Pick<
      NodeWorkerTransferHttpRequest,
      "gatewayUrl" | "tlsFingerprint" | "cloudflareAccess" | "token" | "signal"
    >;
    setStage: (stage: NodeWorkerWorkspaceTransferStage) => void;
  };

async function downloadBuffer(params: NodeWorkerTransferHttpRequest, maxBytes: number) {
  return await withNodeWorkerTransferHttpRequest(
    {
      ...params,
      headers: { ...params.headers, "accept-encoding": "gzip" },
    },
    async (response) => {
      await requireOk(response);
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (!encoding || encoding === "identity") {
        return await readResponseBody(response, maxBytes);
      }
      if (encoding !== "gzip") {
        throw new Error("workspace transfer response has an unsupported content encoding");
      }
      // Bound both wire bytes and expansion. Join response and decoder shutdown
      // on cancellation, corrupt gzip, or either limit before returning.
      return await pipeline(
        response,
        (source) => boundedWorkspaceTransferChunks(source, maxBytes),
        createGunzip(),
        async (source) => await readResponseBody(source, maxBytes),
        { signal: params.signal },
      );
    },
  );
}

const workspaceTransferQueue = new KeyedAsyncQueue();

export function serializeNodeWorkerWorkspace<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return workspaceTransferQueue.enqueue(path.resolve(workspaceDir), operation);
}

async function downloadWorkspace(params: WorkspaceTransferOperation<"download">): Promise<string> {
  let baseSource: "prepared-project-seed" | "gateway-pack" | undefined;
  params.setStage("manifest");
  const raw = await downloadBuffer(
    {
      ...params.request,
      routePath: nodeWorkspaceTransferManifestPath(
        params.environmentId,
        params.transfer.manifestRef,
      ),
      method: "GET",
    },
    MAX_WORKSPACE_MANIFEST_BYTES,
  );
  const { manifest } = await decodeWorkspaceManifest(
    raw.toString("utf8"),
    params.transfer.manifestRef,
    params.signal,
  );
  const checkpointBaseRef = params.transfer.checkpointBaseManifestRef;
  const checkpointBase = checkpointBaseRef
    ? await readNodeRepositoryCheckpointBase({
        manifestHome: params.manifestHome,
        baseManifestRef: checkpointBaseRef,
        current: manifest,
      })
    : undefined;
  const checkpointPaths = checkpointBase
    ? new Set(workerWorkspaceTransferPaths(manifest, checkpointBase, params.signal))
    : undefined;

  if (params.transfer.seedKey && (!manifest.baseCommit || params.transfer.attachments)) {
    throw new Error("Prepared project seeds require a Git workspace transfer");
  }
  const overlay =
    params.prepared && !params.transfer.attachments
      ? await prepareNodeWorkerWorkspaceOverlay({
          prepared: params.prepared,
          manifest,
          manifestRef: params.transfer.manifestRef,
          // Only initial Gateway project sync carries a seed. Accepted publication and
          // explicit checkpoints restore exact snapshots, including setup-output deletions.
          sourceOverlay: Boolean(params.transfer.seedKey) && !checkpointBase,
          hashMemo: params.hashMemo,
          signal: params.signal,
        })
      : undefined;
  const stagedInputs = stagedInputDirectoriesFromEntries(manifest.entries);
  const attachmentEntries = params.transfer.attachments
    ? manifest.entries.filter((entry) => entry.type === "file")
    : undefined;
  if (
    attachmentEntries &&
    (manifest.baseCommit !== null ||
      attachmentEntries.length !== manifest.entries.length ||
      attachmentEntries.some((entry) => !isStagedInputPath(entry.path, stagedInputs)))
  ) {
    throw new Error("Invalid worker attachment manifest");
  }
  params.setStage("materialize");
  const stagingWorkspace = await createNodeWorkerTempWorkspace({
    rootDir: path.dirname(params.workspaceDir),
    prefix: `.${path.basename(params.workspaceDir)}.workspace-transfer-`,
  });
  const staging = stagingWorkspace.dir;
  try {
    const stagingRoot = await fsRoot(staging, { mkdir: false, durable: false });
    // The accepted manifest owns raw path eligibility on every platform.
    const published = await runWorkspaceCommand({
      workspaceDir: staging,
      homeDir: params.manifestHome,
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        staging,
        manifest.baseCommit ?? "",
        "publish",
        params.transfer.manifestRef.slice("sha256:".length),
      ],
      input: raw,
      signal: params.signal,
    });
    if (published.trim() !== params.transfer.manifestRef) {
      throw new Error("workspace transfer manifest publication acknowledgement is invalid");
    }
    if (manifest.baseCommit && !checkpointBase && !overlay) {
      try {
        params.setStage("base");
        let seeded = false;
        if (params.transfer.seedKey) {
          baseSource = "prepared-project-seed";
          if (!params.seedsRoot || !params.gatewayNamespace) {
            throw new Error("Prepared project seed has no machine cache owner");
          }
          seeded = await copyNodeWorkerProjectSeedObjects({
            seedsRoot: params.seedsRoot,
            gatewayNamespace: params.gatewayNamespace,
            seedKey: params.transfer.seedKey,
            workspaceDir: staging,
            signal: params.signal,
          });
        }
        let packPath: string | undefined;
        if (!seeded) {
          baseSource = "gateway-pack";
          packPath = path.join(staging, ".openclaw-base.pack");
          await downloadFile({
            request: {
              ...params.request,
              routePath: nodeWorkspaceTransferPackPath(
                params.environmentId,
                params.transfer.manifestRef,
              ),
              method: "GET",
            },
            root: stagingRoot,
            relativePath: ".openclaw-base.pack",
          });
        }
        await initializeNodeWorkerGitWorkspace({
          workspaceDir: staging,
          manifestHome: params.manifestHome,
          packPath,
          baseCommit: manifest.baseCommit,
          entries: manifest.entries,
          signal: params.signal,
        });
      } catch (error) {
        params.signal?.throwIfAborted();
        if (baseSource === "prepared-project-seed") {
          throw new NodeWorkerWorkspaceTransferError(
            `workspace-transfer-failed: prepared project seed is invalid: ${boundedWorkerError(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    params.setStage("materialize");
    const stagingHashMemo: WorkspaceHashMemo = new Map();
    const downloadedBlobs = new Map<string, string>();
    for (const directory of checkpointBase ? [] : (manifest.directories ?? [])) {
      await stagingRoot.mkdir(`./${directory}`);
    }
    await withWorkerWorkspaceHashMemo(stagingHashMemo, async () => {
      for (const entry of manifest.entries) {
        if (
          overlay
            ? !overlay.changed.has(entry.path)
            : checkpointPaths && !checkpointPaths.has(entry.path)
        ) {
          continue;
        }
        const destination = workspacePath(staging, entry.path);
        const materializedEntry =
          process.platform === "win32" && entry.type === "file" && entry.mode === 0o755
            ? { ...entry, mode: 0o644 }
            : entry;
        if (manifest.baseCommit && (await absoluteEntryMatches(destination, materializedEntry))) {
          continue;
        }
        const parent = path.posix.dirname(entry.path);
        if (parent !== ".") {
          await stagingRoot.mkdir(`./${parent}`);
        }
        await stagingRoot.remove(`./${entry.path}`, {
          recursive: true,
          force: true,
          maxEntries: Infinity,
          maxDepth: Infinity,
        });
        if (entry.type === "symlink") {
          await fsp.symlink(entry.target, destination);
          continue;
        }
        if (overlay && checkpointPaths && !checkpointPaths.has(entry.path)) {
          const source = await overlay.readSourceFile(entry);
          await stagingRoot.create(`./${entry.path}`, source, {
            atomic: true,
            mode: entry.mode,
            assertBeforeMutation: () => params.signal?.throwIfAborted(),
          });
          continue;
        }
        const blobKey = `${entry.sha256}:${entry.size}`;
        const downloaded = downloadedBlobs.get(blobKey);
        if (downloaded) {
          // Reuse validated bytes within this private staging tree, with independent file modes.
          await stagingRoot.copyIn(
            `./${entry.path}`,
            { root: stagingRoot, relativePath: `./${downloaded}` },
            { overwrite: false, mode: entry.mode, maxBytes: entry.size, signal: params.signal },
          );
          continue;
        }
        await downloadFile({
          request: {
            ...params.request,
            routePath: nodeWorkspaceTransferBlobPath(params.environmentId, entry.sha256),
            method: "GET",
          },
          root: stagingRoot,
          relativePath: entry.path,
          expectedBytes: entry.size,
          expectedSha256: entry.sha256,
          mode: entry.mode,
        });
        downloadedBlobs.set(blobKey, entry.path);
      }
    });
    // Reuse only hashes validated on this staging filesystem. Capture still checks
    // the complete tree and current handle identities before the atomic replacement.
    params.setStage("verify");
    if (checkpointBase && checkpointBaseRef && !overlay) {
      await applyNodeRepositoryCheckpoint({
        workspaceDir: params.workspaceDir,
        stagingRoot: staging,
        baseManifestRef: checkpointBaseRef,
        currentManifestRef: params.transfer.manifestRef,
        base: checkpointBase,
        current: manifest,
        signal: params.signal,
      });
      params.hashMemo?.clear();
    } else {
      const observed = overlay
        ? await overlay.apply(staging)
        : await captureManifest({
            workspaceDir: staging,
            manifestHome: params.manifestHome,
            baseCommit: manifest.baseCommit,
            referenceManifestRef: params.transfer.manifestRef,
            hashMemo: stagingHashMemo,
            signal: params.signal,
          });
      if (observed !== params.transfer.manifestRef) {
        throw new Error(
          `workspace transfer materialized a different manifest (${observed}/${params.transfer.manifestRef})`,
        );
      }
    }
    if (attachmentEntries) {
      params.signal?.throwIfAborted();
      const root = await fsRoot(params.workspaceDir);
      for (const directory of stagedInputs) {
        params.signal?.throwIfAborted();
        await ensureStagedInputDirectory(params.workspaceDir, directory, params.signal);
      }
      for (const entry of attachmentEntries) {
        params.signal?.throwIfAborted();
        try {
          // Cancellation may follow publication. Keep published files and prior-turn edits.
          await root.copyIn(
            entry.path,
            { root: stagingRoot, relativePath: workspacePath(stagingRoot.rootReal, entry.path) },
            {
              overwrite: false,
              mode: 0o600,
              maxBytes: entry.size,
              signal: params.signal,
            },
          );
        } catch (error) {
          params.signal?.throwIfAborted();
          if (!(error instanceof FsSafeError) || error.code !== "already-exists") {
            throw error;
          }
          await root.open(entry.path).then((opened) => opened.handle.close());
        }
        params.signal?.throwIfAborted();
      }
    } else if (!overlay && !checkpointBase) {
      // Retain this node's Git state across the atomic workspace swap.
      const git = path.join(params.workspaceDir, ".git");
      const parent = await fsRoot(path.dirname(params.workspaceDir));
      if (manifest.baseCommit && (await parent.exists(path.relative(parent.rootReal, git)))) {
        const stagedGit = path.join(staging, ".git");
        for (const entry of await fsp.readdir(stagedGit)) {
          if (entry !== "objects") {
            await fsp.rm(path.join(stagedGit, entry), { recursive: true, force: true });
          }
        }
        await fsp.cp(git, stagedGit, { recursive: true, verbatimSymlinks: true });
      }
      params.setStage("replace");
      await replaceNodeWorkerDirectory(params.workspaceDir, staging, "workspace", params.signal);
    }
    if (params.hashMemo && !overlay && !checkpointBase) {
      replaceWorkerWorkspaceHashMemoEntries(params.hashMemo, [...stagingHashMemo]);
    }
    if (params.transfer.checkpointGitHistory) {
      let gitHistoryNote: string | undefined;
      const gitPackPath = path.join(staging, "history.pack");
      try {
        await downloadFile({
          request: {
            ...params.request,
            routePath: nodeWorkspaceTransferPackPath(
              params.environmentId,
              params.transfer.manifestRef,
            ),
            method: "GET",
          },
          root: stagingRoot,
          relativePath: "history.pack",
          maxBytes: MAX_WORKSPACE_RESULT_GIT_PACK_BYTES,
        });
        gitHistoryNote = await restoreWorkerWorkspaceHistory({
          root: params.workspaceDir,
          gitHistory: params.transfer.checkpointGitHistory,
          gitPackPath,
          assertCurrent: () => params.signal?.throwIfAborted(),
        });
      } catch (error) {
        params.signal?.throwIfAborted();
        gitHistoryNote = workerHistoryNotAdopted(boundedWorkerError(error));
      }
      return JSON.stringify({ manifestRef: params.transfer.manifestRef, gitHistoryNote });
    }
    return params.transfer.manifestRef;
  } finally {
    await stagingWorkspace.cleanup();
  }
}

async function uploadWorkspace(params: WorkspaceTransferOperation<"upload">): Promise<string> {
  params.setStage("base");
  if (params.transfer.publicationBaseCommit) {
    const { publicationBaseCommit, ...transfer } = params.transfer;
    return await withNodeRepositoryPublication(
      {
        workspaceDir: params.workspaceDir,
        manifestHome: params.manifestHome,
        baseCommit: publicationBaseCommit,
        baseManifestRef: transfer.baseManifestRef,
        signal: params.signal,
      },
      (workspaceDir) =>
        uploadWorkspace({
          ...params,
          workspaceDir,
          transfer: { ...transfer, referenceManifestRef: transfer.baseManifestRef },
          hashMemo: undefined,
        }),
    );
  }
  const { raw: baseRaw, manifest: base } = await readWorkspaceManifest(
    params.manifestHome,
    params.transfer.baseManifestRef,
    params.signal,
  );
  params.setStage("capture");
  const currentRef = await captureManifest({
    workspaceDir: params.workspaceDir,
    manifestHome: params.manifestHome,
    baseCommit: base.baseCommit,
    referenceManifestRef: params.transfer.referenceManifestRef,
    baseManifestRef: params.transfer.baseManifestRef,
    ...(params.hashMemo === undefined ? {} : { hashMemo: params.hashMemo }),
    signal: params.signal,
  });
  const { raw: currentRaw, manifest: current } = await readWorkspaceManifest(
    params.manifestHome,
    currentRef,
    params.signal,
  );
  const changed = new Set(workerWorkspaceTransferPaths(current, base, params.signal));
  const manifestBytes = Buffer.from(currentRaw);
  const baseBytes = Buffer.from(baseRaw);
  params.setStage("snapshot");
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "worker-workspace-upload-",
    },
    async (workspace) => {
      const sourceRoot = await fsRoot(params.workspaceDir, {
        hardlinks: "allow",
        symlinks: "follow-parents-within-root",
      });
      const stagedRoot = await workspace.store.root();
      const files: { name: string; size: number }[] = [];
      for (const entry of current.entries) {
        if (entry.type !== "file" || !changed.has(entry.path)) {
          continue;
        }
        const name = String(files.length);
        // Manifest paths are literal, including a leading "~/" directory.
        await using opened = await sourceRoot.open(`./${entry.path}`);
        const destination = await fsp.open(workspace.path(name), "wx", 0o600);
        try {
          const hash = createHash("sha256");
          const offset = await copyFileHandle(opened.handle, destination, {
            maxBytes: entry.size,
            signal: params.signal,
            onChunk(chunk) {
              hash.update(chunk);
            },
          });
          if (offset !== entry.size || hash.digest("hex") !== entry.sha256) {
            throw new Error("workspace changed while preparing its transfer snapshot");
          }
        } finally {
          await destination.close().catch(() => undefined);
        }
        files.push({ name, size: entry.size });
      }
      const gitResult = await prepareNodeWorkerGitResult({
        ...params,
        resultVersion: params.transfer.resultVersion,
        baseCommit: base.baseCommit,
        packPath: workspace.path("worker-history.pack"),
      });
      const contentLength =
        8 +
        baseBytes.byteLength +
        manifestBytes.byteLength +
        files.reduce((total, file) => total + 8 + file.size, 0) +
        (gitResult?.byteLength ?? 0);
      params.setStage("reconcile");
      return await withNodeWorkerTransferHttpRequest(
        {
          ...params.request,
          routePath: nodeWorkspaceTransferReconcilePath(
            params.environmentId,
            params.transfer.baseManifestRef,
          ),
          method: "POST",
          headers: {
            "content-type": `application/vnd.openclaw.worker-workspace-reconcile-v${params.transfer.resultVersion ?? 1}`,
            "content-length": String(contentLength),
          },
          writeBody: async (write, signal) => {
            for (const value of [baseBytes, manifestBytes]) {
              const header = Buffer.allocUnsafe(4);
              header.writeUInt32BE(value.byteLength);
              await write(header);
              await write(value);
            }
            for (const file of files) {
              const size = Buffer.allocUnsafe(8);
              size.writeBigUInt64BE(BigInt(file.size));
              await write(size);
              signal?.throwIfAborted();
              await using handle = (await stagedRoot.open(file.name)).handle;
              signal?.throwIfAborted();
              for await (const value of handle.createReadStream({ autoClose: false, signal })) {
                await write(Buffer.isBuffer(value) ? value : Buffer.from(value));
              }
            }
            await gitResult?.write(write, signal);
          },
        },
        async (response) => {
          params.setStage("acknowledgement");
          await requireOk(response);
          const payload = JSON.parse(
            (await readResponseBody(response, TRANSFER_RESULT_MAX_BYTES)).toString("utf8"),
          ) as { manifestRef?: unknown };
          if (payload.manifestRef !== currentRef) {
            throw new Error("workspace transfer upload acknowledgement is invalid");
          }
          return currentRef;
        },
      );
    },
  );
}

export async function runNodeWorkerWorkspaceTransfer(
  params: WorkspaceTransferContext,
): Promise<string> {
  let stage: NodeWorkerWorkspaceTransferStage = "recover";
  const setStage = (next: NodeWorkerWorkspaceTransferStage) => {
    stage = next;
  };
  try {
    if (!params.prepared) {
      await recoverWorkspaceReplacement(params.workspaceDir);
    }
    const request = {
      gatewayUrl: params.gatewayUrl,
      tlsFingerprint: params.gatewayTlsFingerprint,
      cloudflareAccess: params.gatewayCloudflareAccess,
      token: params.transfer.token,
      signal: params.signal,
    };
    return params.transfer.direction === "download"
      ? await downloadWorkspace({
          ...params,
          request,
          transfer: params.transfer,
          setStage,
        })
      : await uploadWorkspace({
          ...params,
          request,
          transfer: params.transfer,
          setStage,
        });
  } catch (error) {
    if (error instanceof NodeWorkerWorkspaceTransferError) {
      throw error;
    }
    if (error instanceof NodeWorkerTransferHttpError) {
      const detail =
        error.reason === "cloudflare-access-requires-tls"
          ? "Cloudflare Access credentials require HTTPS"
          : error.reason === "tls-fingerprint-mismatch"
            ? "gateway TLS fingerprint mismatch"
            : error.reason === "invalid-tls-fingerprint"
              ? "gateway TLS fingerprint is invalid"
              : undefined;
      if (detail) {
        throw new NodeWorkerWorkspaceTransferError(`workspace-transfer-failed: ${detail}`, {
          cause: error,
        });
      }
    }
    throw new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: transfer did not complete",
      { cause: error, operation: params.transfer.direction, stage },
    );
  }
}
