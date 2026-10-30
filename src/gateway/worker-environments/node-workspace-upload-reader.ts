import { createHash } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { writeFileWindowFully } from "../../infra/file-descriptor.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import {
  MAX_WORKSPACE_RESULT_GIT_PACK_BYTES,
  type NodeWorkspaceTransferInvalidReason,
} from "../../worker/node-workspace-transfer-protocol.js";
import { nodeWorkspaceTransferEntryPath } from "./node-workspace-transfer-snapshot.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import { decodeWorkspaceManifest } from "./workspace-manifest-worker.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { assertWorkspaceMatchesManifest } from "./workspace-reconcile.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
} from "./workspace-result-inventory.js";

const MAX_UPLOAD_BYTES =
  MAX_WORKSPACE_MANIFEST_BYTES * 2 +
  MAX_RECONCILIATION_TOTAL_BYTES +
  MAX_WORKSPACE_INVENTORY_ENTRIES * 8 +
  8;
const MAX_GIT_HISTORY_BYTES = 1024;
const MAX_V2_UPLOAD_BYTES =
  MAX_UPLOAD_BYTES + MAX_GIT_HISTORY_BYTES + 12 + MAX_WORKSPACE_RESULT_GIT_PACK_BYTES;
export class NodeWorkspaceTransferLimitError extends Error {
  readonly code = "workspace-transfer-limit";
}

class NodeWorkspaceTransferInvalidError extends Error {
  readonly code = "workspace-transfer-invalid";

  constructor(
    readonly reason: NodeWorkspaceTransferInvalidReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function nodeWorkspaceTransferInvalidReason(
  error: unknown,
): NodeWorkspaceTransferInvalidReason | undefined {
  return error instanceof NodeWorkspaceTransferInvalidError ? error.reason : undefined;
}

class RequestByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  readonly #signal: AbortSignal;
  readonly #assertCurrent: () => void;
  readonly #maxBytes: number;
  #pending: Buffer = Buffer.alloc(0);
  #done = false;
  bytesRead = 0;

  constructor(
    request: IncomingMessage,
    signal: AbortSignal,
    assertCurrent: () => void,
    maxBytes: number,
  ) {
    this.#maxBytes = maxBytes;
    this.#iterator = request[Symbol.asyncIterator]();
    this.#signal = signal;
    this.#assertCurrent = assertCurrent;
  }

  async take(maxBytes: number): Promise<Buffer> {
    this.#signal.throwIfAborted();
    if (this.#pending.length === 0 && !this.#done) {
      const next = await this.#iterator.next();
      // Authority cannot change while buffered bytes are consumed in one turn.
      // Revalidate after the iterator yields; callers do the same after their own awaited I/O.
      this.#assertCurrent();
      this.#signal.throwIfAborted();
      this.#done = Boolean(next.done);
      if (!next.done) {
        if (!Buffer.isBuffer(next.value)) {
          throw new NodeWorkspaceTransferInvalidError(
            "payload",
            "Workspace transfer upload must contain binary data",
          );
        }
        this.#pending = next.value;
      }
    }
    if (this.#pending.length === 0) {
      return Buffer.alloc(0);
    }
    const count = Math.min(maxBytes, this.#pending.length);
    const value = this.#pending.subarray(0, count);
    // Coalesced records must not repeatedly copy the unread suffix.
    // Release exhausted chunks rather than retaining their backing storage.
    this.#pending =
      count === this.#pending.length ? Buffer.alloc(0) : this.#pending.subarray(count);
    this.bytesRead += value.byteLength;
    if (this.bytesRead > this.#maxBytes) {
      throw new NodeWorkspaceTransferLimitError("Workspace transfer upload exceeds its byte limit");
    }
    return value;
  }

  async readExactly(bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await this.take(remaining);
      if (chunk.length === 0) {
        throw new NodeWorkspaceTransferInvalidError(
          "premature_eof",
          "Workspace transfer upload ended before its declared payload",
        );
      }
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks, bytes);
  }

  async assertEnd(): Promise<void> {
    if ((await this.take(1)).length !== 0) {
      throw new NodeWorkspaceTransferInvalidError(
        "trailing_bytes",
        "Workspace transfer upload contains trailing bytes",
      );
    }
  }
}

async function streamUploadFile(params: {
  reader: RequestByteReader;
  handle: FileHandle;
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>;
  assertCurrent: () => void;
}): Promise<void> {
  const size = (await params.reader.readExactly(8)).readBigUInt64BE();
  if (size !== BigInt(params.entry.size)) {
    throw new NodeWorkspaceTransferInvalidError(
      "file_size",
      "Workspace transfer file size differs from its manifest",
    );
  }
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < params.entry.size) {
    const chunk = await params.reader.take(Math.min(64 * 1024, params.entry.size - offset));
    if (chunk.length === 0) {
      throw new NodeWorkspaceTransferInvalidError(
        "premature_eof",
        "Workspace transfer upload ended mid-file",
      );
    }
    hash.update(chunk);
    await writeFileWindowFully(params.handle, chunk, offset, {
      assertBeforeMutation: params.assertCurrent,
    });
    params.assertCurrent();
    offset += chunk.length;
  }
  if (hash.digest("hex") !== params.entry.sha256) {
    throw new NodeWorkspaceTransferInvalidError(
      "file_digest",
      "Workspace transfer file digest differs from its manifest",
    );
  }
}

export type NodeWorkspaceTransferUpload = {
  base: WorkerWorkspaceManifest;
  baseManifestRef: string;
  baseRaw: string;
  current: WorkerWorkspaceManifest;
  currentManifestRef: string;
  currentRaw: string;
  stagingRoot: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
};

/** The upload owns both the manifest tree and its optional sibling Git pack. */
export async function removeNodeWorkspaceUpload(
  upload: Pick<NodeWorkspaceTransferUpload, "stagingRoot" | "gitPackPath">,
): Promise<void> {
  try {
    await fsp.rm(upload.stagingRoot, { recursive: true, force: true });
  } finally {
    if (upload.gitPackPath) {
      await fsp.rm(upload.gitPackPath, { force: true });
    }
  }
}

/** Stages one bounded upload before its context owner publishes the authenticated result. */
export async function readNodeWorkspaceUpload(params: {
  request: IncomingMessage;
  baseManifestRef: string;
  resultVersion?: 2;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  isAuthorized: () => boolean;
}): Promise<NodeWorkspaceTransferUpload> {
  const { assertCurrent } = params;
  const wrapValidationError = (
    error: unknown,
    reason: NodeWorkspaceTransferInvalidReason,
    message: string,
  ) =>
    error instanceof WorkerTaskError || (params.signal.aborted && error === params.signal.reason)
      ? error
      : new NodeWorkspaceTransferInvalidError(reason, message, { cause: error });

  let stagingRoot: string | undefined;
  try {
    assertCurrent();
    const maxBytes = params.resultVersion === 2 ? MAX_V2_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    const contentType = params.request.headers["content-type"];
    if (
      contentType !== undefined &&
      contentType !==
        `application/vnd.openclaw.worker-workspace-reconcile-v${params.resultVersion ?? 1}`
    ) {
      throw new NodeWorkspaceTransferInvalidError(
        "payload",
        "Workspace result version was not negotiated",
      );
    }
    const contentLength = Number(params.request.headers["content-length"]);
    if (!Number.isSafeInteger(contentLength) || contentLength < 8 || contentLength > maxBytes) {
      throw new NodeWorkspaceTransferLimitError("Workspace transfer upload exceeds its byte limit");
    }
    const reader = new RequestByteReader(params.request, params.signal, assertCurrent, maxBytes);
    const readManifest = async (expectedRef?: string) => {
      const bytes = (await reader.readExactly(4)).readUInt32BE();
      if (bytes < 2 || bytes > MAX_WORKSPACE_MANIFEST_BYTES) {
        throw new NodeWorkspaceTransferLimitError(
          "Workspace transfer manifest exceeds its byte limit",
        );
      }
      const raw = (await reader.readExactly(bytes)).toString("utf8");
      try {
        const decoded = await decodeWorkspaceManifest(raw, expectedRef, params.signal);
        return { raw, ref: decoded.manifestRef, manifest: decoded.manifest };
      } catch (error) {
        throw wrapValidationError(error, "manifest", "Workspace transfer manifest is invalid");
      }
    };
    const base = await readManifest(params.baseManifestRef);
    assertCurrent();
    const current = await readManifest();
    assertCurrent();
    let transferEntries: WorkerWorkspaceManifestEntry[];
    try {
      params.signal.throwIfAborted();
      transferEntries = parseChangedWorkspaceResult(base.manifest, current.manifest).entries;
    } catch (error) {
      if (params.signal.aborted && error === params.signal.reason) {
        throw error;
      }
      throw new NodeWorkspaceTransferInvalidError(
        "manifest",
        "Workspace transfer manifests cannot be reconciled",
        { cause: error },
      );
    }
    stagingRoot = await fsp.mkdtemp(path.join(params.temporaryRoot, "upload-"));
    for (const entry of transferEntries) {
      try {
        const destination = nodeWorkspaceTransferEntryPath(stagingRoot, entry.path);
        await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        assertCurrent();
        if (entry.type === "symlink") {
          await fsp.symlink(entry.target, destination);
          assertCurrent();
        } else {
          const handle = await fsp.open(destination, "wx", entry.mode);
          try {
            await streamUploadFile({ reader, handle, entry, assertCurrent });
          } finally {
            await handle.close();
          }
          assertCurrent();
        }
      } catch (error) {
        if (error instanceof NodeWorkspaceTransferInvalidError) {
          throw error;
        }
        if (params.signal.aborted || !params.isAuthorized()) {
          throw error;
        }
        throw new NodeWorkspaceTransferInvalidError(
          "staging",
          "Workspace transfer payload could not be staged",
          { cause: error },
        );
      }
    }
    let gitHistory: WorkerWorkspaceGitHistory | undefined;
    let gitPackPath: string | undefined;
    if (params.resultVersion === 2) {
      const historyBytes = (await reader.readExactly(4)).readUInt32BE();
      if (historyBytes > MAX_GIT_HISTORY_BYTES) {
        throw new NodeWorkspaceTransferLimitError(
          "Workspace Git history metadata exceeds its byte limit",
        );
      }
      try {
        const metadata: unknown = JSON.parse(
          (await reader.readExactly(historyBytes)).toString("utf8"),
        );
        gitHistory =
          metadata === null ? undefined : WorkerWorkspaceGitHistorySchema.parse(metadata);
        if (gitHistory && gitHistory.baseCommit !== base.manifest.baseCommit) {
          throw new Error("Git history does not match dispatch base");
        }
      } catch (error) {
        throw wrapValidationError(error, "payload", "Workspace Git history is invalid");
      }
      const packBytes = (await reader.readExactly(8)).readBigUInt64BE();
      if (packBytes > BigInt(MAX_WORKSPACE_RESULT_GIT_PACK_BYTES)) {
        throw new NodeWorkspaceTransferLimitError("Workspace Git pack exceeds its byte limit");
      }
      const needsPack =
        gitHistory?.descendsFromBase &&
        !gitHistory.unavailableReason &&
        gitHistory.headCommit !== gitHistory.baseCommit;
      if (Boolean(needsPack) !== packBytes > 0n) {
        throw new NodeWorkspaceTransferInvalidError(
          "payload",
          "Workspace Git pack does not match its history",
        );
      }
      if (packBytes > 0n) {
        // A sibling keeps transport data outside manifest-controlled workspace paths.
        gitPackPath = path.join(stagingRoot, "../", `${path.basename(stagingRoot)}.pack`);
        const handle = await fsp.open(gitPackPath, "wx", 0o600);
        try {
          let offset = 0;
          while (offset < Number(packBytes)) {
            const chunk = await reader.readExactly(Math.min(64 * 1024, Number(packBytes) - offset));
            await writeFileWindowFully(handle, chunk, offset, {
              assertBeforeMutation: assertCurrent,
            });
            assertCurrent();
            offset += chunk.length;
          }
        } finally {
          await handle.close();
        }
      }
    }
    await reader.assertEnd();
    assertCurrent();
    if (reader.bytesRead !== contentLength) {
      throw new NodeWorkspaceTransferInvalidError(
        "content_length",
        "Workspace transfer upload length is inconsistent",
      );
    }
    try {
      await assertWorkspaceMatchesManifest({
        root: stagingRoot,
        manifest: current.manifest,
        entries: transferEntries,
      });
    } catch (error) {
      // Discard joins this validation; a later cancellation must not hide its failure.
      throw wrapValidationError(
        error,
        "staging",
        "Workspace transfer payload did not match its staged result",
      );
    }
    assertCurrent();
    return {
      base: base.manifest,
      baseManifestRef: params.baseManifestRef,
      baseRaw: base.raw,
      current: current.manifest,
      currentManifestRef: current.ref,
      currentRaw: current.raw,
      stagingRoot,
      ...(gitHistory ? { gitHistory } : {}),
      ...(gitPackPath ? { gitPackPath } : {}),
    };
  } catch (error) {
    if (stagingRoot) {
      await removeNodeWorkspaceUpload({ stagingRoot, gitPackPath: `${stagingRoot}.pack` });
    }
    throw error;
  }
}
