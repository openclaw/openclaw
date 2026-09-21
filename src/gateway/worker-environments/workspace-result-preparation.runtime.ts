import fs from "node:fs/promises";
import { readWorkspaceFileContentsWithLimit } from "./workspace-actual-manifest.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import type { WorkspaceManifestComputationOperations } from "./workspace-manifest-computation.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { absoluteEntryMatches, localPath } from "./workspace-reconcile-fs.js";
import {
  requireWorkerResultStorageRef,
  STAGED_RESULT_MESSAGE,
} from "./workspace-result-inventory.js";

function stagedResultMessage(params: {
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: Uint8Array<ArrayBuffer>;
  currentManifestRaw: Uint8Array<ArrayBuffer>;
}): { chunks: Buffer[]; byteLength: number } {
  const base = Buffer.from(
    params.baseManifestRaw.buffer,
    params.baseManifestRaw.byteOffset,
    params.baseManifestRaw.byteLength,
  );
  const current = Buffer.from(
    params.currentManifestRaw.buffer,
    params.currentManifestRaw.byteOffset,
    params.currentManifestRaw.byteLength,
  );
  const header = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 2\nbase-ref ${params.baseManifestRef}\ncurrent-ref ${params.currentManifestRef}\nbase-bytes ${base.byteLength}\ncurrent-bytes ${current.byteLength}\n\n`,
  );
  return {
    chunks: [header, base, current],
    byteLength: header.byteLength + base.byteLength + current.byteLength,
  };
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

export async function buildWorkspaceStageInput(
  params: WorkspaceManifestComputationOperations["workspace.manifest.stage-input"]["input"],
): Promise<null> {
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const compared = parseChangedWorkspaceResult(
    parseWorkerWorkspaceManifest(
      Buffer.from(
        params.baseManifestRaw.buffer,
        params.baseManifestRaw.byteOffset,
        params.baseManifestRaw.byteLength,
      ).toString("utf8"),
      params.baseManifestRef,
    ),
    parseWorkerWorkspaceManifest(
      Buffer.from(
        params.currentManifestRaw.buffer,
        params.currentManifestRaw.byteOffset,
        params.currentManifestRaw.byteLength,
      ).toString("utf8"),
      params.currentManifestRef,
    ),
  );
  // The authenticated manifests define the complete result. The durable tree
  // stores only changed resulting blobs; deletions intentionally have no blob.
  const entries = compared.entries.toSorted((left, right) => left.path.localeCompare(right.path));
  const input = await fs.open(params.inputPath, "wx", 0o600);
  try {
    for (const [index, entry] of entries.entries()) {
      const source = localPath(params.stagingRoot, entry.path);
      let content: Uint8Array;
      if (entry.type === "symlink") {
        if (!(await absoluteEntryMatches(source, entry))) {
          throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`);
        }
        content = Buffer.from(entry.target);
      } else {
        const snapshot = await readWorkspaceFileContentsWithLimit(source, entry.size).catch(
          (error: unknown) => {
            throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`, {
              cause: error,
            });
          },
        );
        if (
          snapshot.type !== "file" ||
          snapshot.size !== entry.size ||
          snapshot.mode !== entry.mode ||
          snapshot.sha256 !== entry.sha256
        ) {
          throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`);
        }
        content = snapshot.content;
      }
      await input.writeFile(
        Buffer.concat([
          Buffer.from(`blob\nmark :${index + 1}\ndata ${content.byteLength}\n`),
          content,
          Buffer.from("\n"),
        ]),
      );
    }
    const message = stagedResultMessage(params);
    await input.writeFile(
      `commit ${stagedResultRef}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\ndata ${message.byteLength}\n`,
    );
    for (const chunk of message.chunks) {
      await input.writeFile(chunk);
    }
    await input.writeFile("\ndeleteall\n");
    for (let offset = 0; offset < entries.length; offset += 256) {
      await input.writeFile(
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
    await input.writeFile("done\n");
  } finally {
    await input.close();
  }
  return null;
}
