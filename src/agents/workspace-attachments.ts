import { createHash } from "node:crypto";
import path from "node:path";
import { resolveChatAttachmentMaxBytes } from "../gateway/chat-attachment-policy.js";
import { readLocalMediaFile } from "../media/local-media-access.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import {
  STAGED_INPUT_MAX_BYTES,
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../media/staged-inputs.js";
import { getMediaDir } from "../media/store.js";
import { resolveMediaFactLocalRef } from "./embedded-agent-runner/run/images.media-refs.js";
import type { createWorkspaceAttachmentPreparer } from "./workspace-attachment-preparer.js";

type Preparer = ReturnType<typeof createWorkspaceAttachmentPreparer>;

/** Prepare only admitted input files; canonical references remain on Gateway. */
export async function prepareWorkspaceAttachments(
  params: Parameters<typeof createWorkspaceAttachmentPreparer>[0] & {
    turn: Parameters<Preparer>[0];
    assertCurrent: () => void;
  },
): Promise<string | undefined> {
  const { turn } = params;
  const signal = AbortSignal.any([
    AbortSignal.timeout(turn.timeoutMs),
    ...(turn.abortSignal ? [turn.abortSignal] : []),
  ]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  const bridge = params.createBridge(assertCurrent, signal);
  const root = {
    async exists(filePath: string) {
      assertCurrent();
      const stat = await bridge.stat({ filePath, signal });
      assertCurrent();
      return stat !== null;
    },
    async readText(filePath: string, { maxBytes }: { maxBytes: number }) {
      assertCurrent();
      const data = await bridge.readFile({ filePath, maxBytes, signal });
      assertCurrent();
      return data.toString("utf8");
    },
    async create(filePath: string, data: string) {
      assertCurrent();
      const result = await bridge.createFileExclusive({ filePath, data, mkdir: true, signal });
      assertCurrent();
      if (result === "exists" && (await root.readText(filePath, { maxBytes: 1024 })) !== data) {
        throw new Error("Input staging directory is not owned by OpenClaw");
      }
    },
  };
  const paths = new Map<string, string>();
  for (const fact of turn.media ?? []) {
    assertCurrent();
    const ref = resolveMediaFactLocalRef(fact);
    if (!ref) {
      continue;
    }
    const source = await resolveMediaReferenceLocalPath(ref.resolved);
    assertCurrent();
    if (!path.isAbsolute(source)) {
      throw new Error("Attachment source must be a managed reference or an absolute media path");
    }
    if (paths.has(source)) {
      continue;
    }
    // Inbound store and channel remote-cache only, not arbitrary workspace files.
    const data = await readLocalMediaFile(source, [getMediaDir()], {
      maxBytes: Math.max(STAGED_INPUT_MAX_BYTES, resolveChatAttachmentMaxBytes(turn.config ?? {})),
    });
    assertCurrent();
    const directory = stagedInputDirectory(createHash("sha256").update(source).digest("hex"));
    await ensureStagedInputDirectory(root, directory, signal);
    assertCurrent();
    const filePath = path.posix.join(directory, stagedInputFileName(path.basename(source)));
    await bridge.createFileExclusive({ filePath, data, mkdir: false, signal });
    assertCurrent();
    const stat = await bridge.stat({ filePath, signal });
    assertCurrent();
    if (stat?.type !== "file") {
      throw new Error("Prepared attachment is not a regular file");
    }
    const remotePath = path.posix.isAbsolute(params.remoteRoot)
      ? path.posix.join(params.remoteRoot, filePath)
      : path.win32.join(params.remoteRoot, ...filePath.split("/"));
    paths.set(source, remotePath);
  }
  assertCurrent();
  return paths.size
    ? [...paths.values()].map((file) => `[media attached: ${file}]`).join("\n")
    : undefined;
}
