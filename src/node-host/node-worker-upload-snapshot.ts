import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { workspaceStatIdentity } from "../gateway/worker-environments/workspace-hash-memo.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { root, type Root } from "../infra/fs-safe.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type UploadSource = { path: string; size: number; sha256: string };
type UploadFile = { name: string; size: number };
type UploadSnapshot = {
  files: UploadFile[];
  stream(
    file: UploadFile,
    write: (chunk: Buffer) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
};

async function stageUploadSource(params: {
  source: UploadSource;
  workspace: Root;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  // Manifest paths are literal, including a leading "~/" directory.
  await using opened = await params.workspace.open(`./${params.source.path}`);
  const source = opened.handle;
  const destination = await fsp.open(params.destination, "wx", 0o600);
  try {
    const before = await source.stat({ bigint: true });
    const identity = workspaceStatIdentity("worker", before);
    const hash = createHash("sha256");
    const offset = await copyFileHandle(source, destination, {
      maxBytes: params.source.size,
      signal: params.signal,
      onChunk(chunk) {
        hash.update(chunk);
      },
    });
    const after = await source.stat({ bigint: true });
    if (
      offset !== params.source.size ||
      workspaceStatIdentity("worker", after) !== identity ||
      hash.digest("hex") !== params.source.sha256
    ) {
      throw new Error("workspace changed while preparing its transfer snapshot");
    }
  } finally {
    await destination.close().catch(() => undefined);
  }
}

/** Freezes changed workspace bytes before the transfer request can observe later writes. */
export async function withNodeWorkerUploadSnapshot<T>(
  params: {
    workspaceDir: string;
    sources: UploadSource[];
    signal?: AbortSignal;
  },
  upload: (snapshot: UploadSnapshot) => Promise<T>,
): Promise<T> {
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "worker-workspace-upload-",
    },
    async (workspace) => {
      const sourceRoot = await root(params.workspaceDir, {
        hardlinks: "allow",
        nonBlockingRead: true,
        symlinks: "follow-parents-within-root",
      });
      const stagedRoot = await workspace.store.root();
      const files: UploadFile[] = [];
      for (const [index, source] of params.sources.entries()) {
        const name = String(index);
        await stageUploadSource({
          source,
          workspace: sourceRoot,
          destination: workspace.path(name),
          signal: params.signal,
        });
        files.push({ name, size: source.size });
      }
      return await upload({
        files,
        stream: async (file, write, signal) => {
          signal?.throwIfAborted();
          await using handle = (await stagedRoot.open(file.name)).handle;
          for await (const value of handle.createReadStream({ autoClose: false, signal })) {
            await write(Buffer.isBuffer(value) ? value : Buffer.from(value));
          }
        },
      });
    },
  );
}
