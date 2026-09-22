import path from "node:path";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { readWorkspaceFileContentsWithLimit } from "./workspace-actual-manifest.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";
import type { WorkerWorkspaceManifestEntry } from "./workspace-manifest.js";
import { absoluteEntryMatches, localPath } from "./workspace-reconcile-fs.js";

export async function readWorkspaceGitEntry(
  root: string,
  entry: WorkerWorkspaceManifestEntry,
): Promise<Uint8Array> {
  const source = localPath(root, entry.path);
  if (entry.type === "symlink") {
    if (await absoluteEntryMatches(source, entry)) {
      return Buffer.from(entry.target);
    }
  } else {
    const snapshot = await readWorkspaceFileContentsWithLimit(source, entry.size);
    if (
      snapshot.type === "file" &&
      snapshot.size === entry.size &&
      snapshot.mode === entry.mode &&
      snapshot.sha256 === entry.sha256
    ) {
      return snapshot.content;
    }
  }
  throw new Error(`Cloud workspace snapshot is invalid: ${entry.path}`);
}

function quoteFastImportPath(entryPath: string): string {
  const bytes = Buffer.from(entryPath);
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0) {
      throw new Error("Cloud workspace staged result path contains a null byte");
    }
    if (byte === 0x22 || byte === 0x5c) {
      quoted += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= 0x20 && byte < 0x7f) {
      quoted += String.fromCharCode(byte);
    } else {
      quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return `${quoted}"`;
}

/** Both durable results and rollback trees import the exact authenticated bytes. */
export async function writeWorkspaceGitInput(params: {
  inputPath: string;
  ref: string;
  entries: readonly WorkerWorkspaceManifestEntry[];
  readVerifiedContent: (entry: WorkerWorkspaceManifestEntry) => Promise<Uint8Array>;
  message?: { chunks: readonly Uint8Array[]; byteLength: number };
  assertBeforeMutation?: () => void;
}): Promise<void> {
  const entries = params.entries.toSorted((left, right) => left.path.localeCompare(right.path));
  async function* chunks() {
    for (const [index, entry] of entries.entries()) {
      const content = await params.readVerifiedContent(entry);
      yield Buffer.from(`blob\nmark :${index + 1}\ndata ${content.byteLength}\n`);
      yield content;
      yield Buffer.from("\n");
    }
    yield Buffer.from(
      `commit ${params.ref}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\ndata ${params.message?.byteLength ?? 0}\n`,
    );
    yield* params.message?.chunks ?? [];
    yield Buffer.from("\ndeleteall\n");
    for (let offset = 0; offset < entries.length; offset += 256) {
      yield Buffer.from(
        entries
          .slice(offset, offset + 256)
          .map((entry, index) => {
            const mode =
              entry.type === "symlink"
                ? "120000"
                : (entry.mode & 0o111) !== 0
                  ? "100755"
                  : "100644";
            return `M ${mode} :${offset + index + 1} ${quoteFastImportPath(entry.path)}\n`;
          })
          .join(""),
      );
    }
    yield Buffer.from("done\n");
  }
  const directory = await fsRoot(path.dirname(params.inputPath));
  await directory.create(path.basename(params.inputPath), chunks(), {
    assertBeforeMutation: params.assertBeforeMutation,
    mode: 0o600,
    mkdir: false,
    durable: false,
    // Inventory limits also bound manifests, quoted paths, and per-entry framing.
    maxBytes: MAX_WORKSPACE_INVENTORY_TOTAL_BYTES * 2,
  });
}
