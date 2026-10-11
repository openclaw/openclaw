import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import {
  validateWorkerAdmissionHandshake,
  type WorkerAdmissionHandshake,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import { extractErrorCode, hasErrnoCode } from "../infra/errors.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveRuntimeArgs } from "../infra/runtime-worker-url.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  extractWorkerBundleArchive,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import {
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ENTRY_PATH,
  workerBundleArchiveRelativePath,
} from "../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";
import {
  nodeWorkerBundleTransferPath,
  NodeWorkerBundleInstallError,
  type NodeWorkerBundleInstallInput,
} from "../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../worker/worker-build-identity.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  NodeWorkerTransferHttpError,
  withNodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";
import { replaceNodeWorkerDirectory } from "./node-worker-workspace-replacement.js";

const INSTALL_RECEIPT = "bootstrap-receipt.json";
const INSTALL_IGNORED_TOP_LEVEL = new Set([INSTALL_RECEIPT]);
const BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STAGING_PATTERN = /^\.staging-[a-f0-9]{64}-/u;
const PREVIOUS_PATTERN = /^[a-f0-9]{64}\.previous-/u;
const BUNDLE_DELETE_BATCH = 16;
const WORKER_PREWARM_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TRANSIENT_CODES = new Set([
  "ARTIFACT_RANGE_MISMATCH",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ABORT_ERR",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);
const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("node/worker-bundle");

async function readErrorResponseCode(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] | undefined = response.statusCode === 503 ? [] : undefined;
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > 64 * 1024) {
      response.destroy(new Error("worker bundle transfer response exceeded its byte limit"));
      throw new Error("worker bundle transfer response exceeded its byte limit");
    }
    chunks?.push(chunk);
  }
  if (chunks) {
    try {
      const details: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (isRecord(details) && details.error === "transfer_in_progress") {
        return "TRANSFER_IN_PROGRESS";
      }
    } catch {
      // Proxy errors need not carry the Gateway's structured busy response.
    }
  }
  return `HTTP_${response.statusCode ?? 0}`;
}

async function writeBundleArchive(params: {
  source: AsyncIterable<Uint8Array>;
  archive: NodeWorkerBundleInstallInput["archive"];
  destination: string;
  offset?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const output = await fsp.open(params.destination, params.offset ? "a" : "wx", 0o600);
  let bytes = params.offset ?? 0;
  try {
    params.signal?.throwIfAborted();
    for await (const chunk of params.source) {
      params.signal?.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > params.archive.bytes || bytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
        throw new Error("worker bundle archive exceeded its byte limit");
      }
      await output.writeFile(chunk);
    }
    params.signal?.throwIfAborted();
  } finally {
    await output.close();
  }
}

async function verifyBundleArchive(params: {
  destination: string;
  archive: NodeWorkerBundleInstallInput["archive"];
  signal?: AbortSignal;
}): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(params.destination, { signal: params.signal })) {
    bytes += chunk.byteLength;
    if (bytes > params.archive.bytes || bytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
      throw new Error("worker bundle archive exceeded its byte limit");
    }
    hash.update(chunk);
  }
  params.signal?.throwIfAborted();
  if (bytes !== params.archive.bytes || hash.digest("hex") !== params.archive.sha256) {
    throw new Error("worker bundle archive failed integrity validation");
  }
}

async function acquireBundle(params: {
  packageRoot: string | null;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  input: NodeWorkerBundleInstallInput;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.packageRoot) {
    const root = await fsSafeRoot(params.packageRoot);
    let opened;
    try {
      opened = await root.open(workerBundleArchiveRelativePath(params.input.archive.sha256));
    } catch (error) {
      // Only an absent source takes the authenticated update path. Unsafe local bytes fail closed.
      if (!(error instanceof FsSafeError) || error.code !== "not-found") {
        throw error;
      }
    }
    if (opened) {
      try {
        // Root.open pins a contained regular file; its streaming API does not enforce maxBytes.
        if (
          opened.stat.size !== params.input.archive.bytes ||
          opened.stat.size > MAX_WORKER_BUNDLE_ARCHIVE_BYTES
        ) {
          throw new Error("prepared worker bundle archive has an unexpected length");
        }
        const source = opened.handle.createReadStream({ autoClose: false });
        try {
          await writeBundleArchive({ ...params, source, archive: params.input.archive });
        } finally {
          source.destroy();
        }
      } finally {
        await opened.handle.close();
      }
      log.info(`Worker bundle already prepared locally: ${params.input.archive.sha256}`);
      return;
    }
  }
  const archive = params.input.archive;
  let offset = 0;
  let retries = 0;
  let noProgressFailures = 0;
  for (;;) {
    params.signal?.throwIfAborted();
    // A reset after the final bytes needs whole-file verification, not a Range past EOF.
    if (offset === archive.bytes) {
      return;
    }
    try {
      if (retries > 0) {
        await delay(
          Math.round(250 * 2 ** Math.min(retries - 1, 3) * (0.5 + Math.random())),
          undefined,
          { signal: params.signal },
        );
      }
      params.signal?.throwIfAborted();
      await withNodeWorkerTransferHttpRequest(
        {
          gatewayUrl: params.gatewayUrl,
          tlsFingerprint: params.gatewayTlsFingerprint,
          cloudflareAccess: params.gatewayCloudflareAccess,
          routePath: nodeWorkerBundleTransferPath(params.input.build.bundleHash),
          method: "GET",
          token: archive.token,
          headers: offset ? { range: `bytes=${offset}-` } : undefined,
          signal: params.signal,
        },
        async (response) => {
          const status = response.statusCode;
          if (
            (status === 416 && offset > 0) ||
            (status === 206 &&
              response.headers["content-range"] !==
                `bytes ${offset}-${archive.bytes - 1}/${archive.bytes}`)
          ) {
            await fsp.rm(params.destination, { force: true });
            throw Object.assign(new Error("gateway returned an unexpected worker bundle range"), {
              code: "ARTIFACT_RANGE_MISMATCH",
            });
          }
          if (status !== 200 && status !== 206) {
            const code = await readErrorResponseCode(response);
            throw Object.assign(new Error(`gateway returned ${status ?? 0}`), { code });
          }
          const start = status === 200 ? 0 : offset;
          if (status === 200) {
            // A proxy may ignore Range. Never append a full response to the retained prefix.
            await fsp.rm(params.destination, { force: true });
          }
          if (Number(response.headers["content-length"]) !== archive.bytes - start) {
            await fsp.rm(params.destination, { force: true });
            throw Object.assign(new Error("gateway returned an unexpected worker bundle length"), {
              code: status === 206 ? "ARTIFACT_RANGE_MISMATCH" : undefined,
            });
          }
          await writeBundleArchive({ ...params, source: response, archive, offset: start });
        },
      );
      return;
    } catch (error) {
      params.signal?.throwIfAborted();
      const code = extractErrorCode(error);
      const busy = code === "TRANSFER_IN_PROGRESS";
      if (!busy && !DOWNLOAD_TRANSIENT_CODES.has(code ?? "")) {
        throw error;
      }
      if (!busy) {
        const retainedBytes = await fsp.stat(params.destination).then(
          (stat) => stat.size,
          (statError: unknown) => {
            if (hasErrnoCode(statError, "ENOENT")) {
              return 0;
            }
            throw statError;
          },
        );
        // Replayed bytes from a proxy ignoring Range do not count as retained progress.
        noProgressFailures = retainedBytes > offset ? 0 : noProgressFailures + 1;
        offset = retainedBytes;
      }
      if (noProgressFailures === 3) {
        throw new Error("worker bundle download stopped after 3 consecutive no-progress failures", {
          cause: error,
        });
      }
      retries++;
    }
  }
}

async function readReceipt(bundleDir: string): Promise<WorkerAdmissionHandshake | undefined> {
  try {
    const raw = JSON.parse(
      await fsp.readFile(path.join(bundleDir, INSTALL_RECEIPT), "utf8"),
    ) as unknown;
    return validateWorkerAdmissionHandshake(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function validateInstalledBundle(
  bundleDir: string,
  expected: WorkerAdmissionHandshake,
): Promise<boolean> {
  try {
    const rootStats = await fsp.lstat(bundleDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return false;
    }
    const receipt = await readReceipt(bundleDir);
    if (!receipt || !sameWorkerBuild(receipt, expected)) {
      return false;
    }
    const manifest = await readWorkerBundleDirectoryManifest({
      root: bundleDir,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      ignoreTopLevel: INSTALL_IGNORED_TOP_LEVEL,
    });
    if (hashWorkerBundleManifest(manifest) !== expected.bundleHash) {
      return false;
    }
    const root = await fsp.realpath(bundleDir);
    const entry = await fsp.realpath(path.join(root, WORKER_BUNDLE_ENTRY_PATH));
    return isPathInside(root, entry) && (await fsp.stat(entry)).isFile();
  } catch {
    return false;
  }
}

async function removeStaleInstallStaging(bundlesRoot: string): Promise<void> {
  const entries = await fsp.readdir(bundlesRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".staging-") && entry.isDirectory() && !entry.isSymbolicLink()) {
        await fsp.rm(path.join(bundlesRoot, entry.name), { recursive: true, force: true });
      }
    }),
  );
}

export class NodeWorkerBundleInstaller {
  readonly #root: string;
  readonly #packageRoot: string | null;
  readonly #operations = new KeyedAsyncQueue();
  readonly #bundleGenerationsByNamespace = new Map<string, Map<string, number>>();
  readonly #currentGenerationByNamespace = new Map<string, number>();
  readonly #prewarmedBundles = new Set<string>();
  readonly #workerEnv: NodeJS.ProcessEnv;

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.#root = path.resolve(options.root ?? path.join(resolveStateDir(env), "node-host"));
    this.#packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    this.#workerEnv = snapshotNodeWorkerEnv(env);
  }

  #markPendingRetention(gatewayNamespace: string, bundleHash: string): void {
    const generation = (this.#currentGenerationByNamespace.get(gatewayNamespace) ?? 0) + 1;
    this.#currentGenerationByNamespace.set(gatewayNamespace, generation);
    const generations =
      this.#bundleGenerationsByNamespace.get(gatewayNamespace) ?? new Map<string, number>();
    generations.set(bundleHash, generation);
    this.#bundleGenerationsByNamespace.set(gatewayNamespace, generations);
  }

  async #prewarmBundle(bundleDir: string, signal?: AbortSignal): Promise<void> {
    if (this.#prewarmedBundles.has(bundleDir)) {
      return;
    }
    try {
      await execFileAsync(
        process.execPath,
        [
          ...resolveRuntimeArgs(),
          path.join(bundleDir, WORKER_BUNDLE_ENTRY_PATH),
          "--internal-worker-prewarm",
        ],
        {
          cwd: bundleDir,
          env: this.#workerEnv,
          timeout: WORKER_PREWARM_TIMEOUT_MS,
          windowsHide: true,
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw error;
    }
    this.#prewarmedBundles.add(bundleDir);
  }

  async ensure(params: {
    input: NodeWorkerBundleInstallInput;
    gatewayUrl: string;
    gatewayTlsFingerprint?: string;
    gatewayCloudflareAccess?: CloudflareAccessCredentials;
    signal?: AbortSignal;
  }): Promise<WorkerAdmissionHandshake> {
    const { input } = params;
    // One namespace owns every staging sibling, so serialize it before sweeping crash residue.
    const key = input.gatewayNamespace;
    return await this.#operations.enqueue(key, async () => {
      try {
        params.signal?.throwIfAborted();
        const bundlesRoot = path.join(this.#root, input.gatewayNamespace, "bundles");
        const destination = path.join(bundlesRoot, input.build.bundleHash);
        const installed = await validateInstalledBundle(destination, input.build);
        params.signal?.throwIfAborted();
        if (!installed) {
          await fsp.mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
          await removeStaleInstallStaging(bundlesRoot);
          const operationRoot = await fsp.mkdtemp(
            path.join(bundlesRoot, `.staging-${input.build.bundleHash}-`),
          );
          try {
            const archivePath = path.join(operationRoot, "bundle.tgz");
            const staging = path.join(operationRoot, "root");
            params.signal?.throwIfAborted();
            await acquireBundle({
              packageRoot: this.#packageRoot,
              gatewayUrl: params.gatewayUrl,
              gatewayTlsFingerprint: params.gatewayTlsFingerprint,
              gatewayCloudflareAccess: params.gatewayCloudflareAccess,
              input,
              destination: archivePath,
              signal: params.signal,
            });
            params.signal?.throwIfAborted();
            await verifyBundleArchive({
              destination: archivePath,
              archive: input.archive,
              signal: params.signal,
            });
            await extractWorkerBundleArchive({
              tarballPath: archivePath,
              destination: staging,
              expectedBundleHash: input.build.bundleHash,
              limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
            });
            params.signal?.throwIfAborted();
            const receipt = await fsp.open(path.join(staging, INSTALL_RECEIPT), "wx", 0o600);
            try {
              params.signal?.throwIfAborted();
              await receipt.writeFile(`${JSON.stringify(input.build)}\n`);
              await receipt.sync();
            } finally {
              await receipt.close();
            }
            await replaceNodeWorkerDirectory(destination, staging, "bundle", params.signal);
            if (!(await validateInstalledBundle(destination, input.build))) {
              throw new Error("published worker bundle failed validation");
            }
          } finally {
            await fsp.rm(operationRoot, { recursive: true, force: true });
          }
        }
        params.signal?.throwIfAborted();
        if (input.bundlePrewarm) {
          await this.#prewarmBundle(destination, params.signal);
        }
        params.signal?.throwIfAborted();
        this.#markPendingRetention(input.gatewayNamespace, input.build.bundleHash);
        return structuredClone(input.build);
      } catch (error) {
        if (error instanceof NodeWorkerBundleInstallError) {
          throw error;
        }
        if (error instanceof NodeWorkerTransferHttpError) {
          throw new NodeWorkerBundleInstallError(
            error.reason === "tls-fingerprint-mismatch"
              ? "worker-bundle-install-failed: gateway TLS fingerprint mismatch"
              : error.reason === "cloudflare-access-requires-tls"
                ? "worker-bundle-install-failed: Cloudflare Access credentials require HTTPS"
                : "worker-bundle-install-failed: gateway transfer is unavailable",
            { cause: error },
          );
        }
        const detail = truncateUtf16Safe(
          redactSensitiveText(error instanceof Error ? error.message : String(error)),
          512,
        );
        throw new NodeWorkerBundleInstallError(
          `worker-bundle-install-failed: ${detail || "bundle installation did not complete"}`,
          { cause: error },
        );
      }
    });
  }

  async inspect(params: {
    gatewayNamespace: string;
    bundleHash: string;
  }): Promise<{ bundleHash: string; status: "installed" | "missing" }> {
    return await this.#operations.enqueue(params.gatewayNamespace, async () => {
      const bundleDir = path.join(
        this.#root,
        params.gatewayNamespace,
        "bundles",
        params.bundleHash,
      );
      const receipt = await readReceipt(bundleDir);
      const installed =
        receipt?.bundleHash === params.bundleHash &&
        (await validateInstalledBundle(bundleDir, receipt));
      return { bundleHash: params.bundleHash, status: installed ? "installed" : "missing" };
    });
  }

  async retain(params: {
    gatewayNamespace: string;
    bundleHashes: readonly string[];
    acknowledgedGeneration?: number;
  }): Promise<{ deleted: number; hasMore: boolean; generation: number }> {
    return await this.#operations.enqueue(params.gatewayNamespace, async () => {
      const bundlesRoot = path.join(this.#root, params.gatewayNamespace, "bundles");
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(bundlesRoot, { withFileTypes: true });
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return {
            deleted: 0,
            hasMore: false,
            generation: this.#currentGenerationByNamespace.get(params.gatewayNamespace) ?? 0,
          };
        }
        throw error;
      }
      const protectedHashes = new Set(params.bundleHashes);
      const generations = this.#bundleGenerationsByNamespace.get(params.gatewayNamespace);
      const acknowledgedGeneration = params.acknowledgedGeneration ?? 0;
      if (generations) {
        for (const [bundleHash, generation] of generations) {
          if (generation > acknowledgedGeneration) {
            protectedHashes.add(bundleHash);
          } else {
            generations.delete(bundleHash);
          }
        }
        if (generations.size === 0) {
          this.#bundleGenerationsByNamespace.delete(params.gatewayNamespace);
        }
      }
      const candidates = entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            ((BUNDLE_HASH_PATTERN.test(entry.name) && !protectedHashes.has(entry.name)) ||
              STAGING_PATTERN.test(entry.name) ||
              PREVIOUS_PATTERN.test(entry.name)),
        )
        .map((entry) => entry.name)
        .toSorted();
      const selected = candidates.slice(0, BUNDLE_DELETE_BATCH);
      for (const name of selected) {
        const target = path.join(bundlesRoot, name);
        await fsp.rm(target, { recursive: true, force: true });
        this.#prewarmedBundles.delete(target);
      }
      return {
        deleted: selected.length,
        hasMore: candidates.length > selected.length,
        generation: this.#currentGenerationByNamespace.get(params.gatewayNamespace) ?? 0,
      };
    });
  }
}

export type NodeWorkerBundleInstallerControl = Pick<NodeWorkerBundleInstaller, "ensure"> &
  Partial<Pick<NodeWorkerBundleInstaller, "inspect" | "retain">>;
