import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveFileExtractionLimits } from "../media-understanding/file-extraction-limits.js";
import { resolveLocalMediaRoots } from "../media/local-media-access.js";
import type { MediaFact } from "../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import { getMediaDir } from "../media/store.js";
import { wrapExternalContent } from "../security/external-content.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import { resolveMediaFactLocalRef } from "./embedded-agent-runner/run/images.media-refs.js";

export type LocalAttachmentExecutionContext = {
  config?: OpenClawConfig;
  readAllowed: boolean;
  maxChars: number;
};

// Classification inspects signatures and a bounded text sample, never the full document.
const ATTACHMENT_HEADER_BYTES = 8192;

/** Resolve current managed documents for an eligible local host execution only. */
export async function prepareLocalWorkspaceAttachments(params: {
  media: readonly MediaFact[];
  execution: LocalAttachmentExecutionContext;
  assertCurrent: () => void;
}): Promise<string | undefined> {
  const { execution } = params;
  if (!execution.readAllowed) {
    return undefined;
  }
  const readScope = captureChannelReadScope();
  const assertCurrent = () => {
    params.assertCurrent();
    readScope?.assertCurrent();
  };
  assertCurrent();
  const roots = await resolveLocalMediaRoots([getMediaDir()]);
  assertCurrent();
  const limits = resolveFileExtractionLimits(execution.config ?? {});
  const maxChars = Number.isFinite(execution.maxChars)
    ? Math.max(0, Math.floor(execution.maxChars))
    : 0;
  const files: Array<{ reference: string; path: string; name?: string }> = [];
  let metadataChars = 0;
  for (const fact of params.media) {
    const ref = resolveMediaFactLocalRef(fact);
    if (!ref) {
      continue;
    }
    try {
      assertCurrent();
      const filePath = await resolveMediaReferenceLocalPath(ref.resolved);
      assertCurrent();
      if (!path.isAbsolute(filePath) || !roots.some((root) => isPathInside(root, filePath))) {
        continue;
      }
      const opened = await openLocalFileSafely({ filePath });
      let classification: Awaited<ReturnType<typeof classifyAttachmentBytes>>;
      {
        await using handle = opened.handle;
        assertCurrent();
        if (
          opened.stat.nlink > 1 ||
          opened.stat.size > limits.maxBytes ||
          !roots.some((root) => isPathInside(root, opened.realPath))
        ) {
          continue;
        }
        const header = Buffer.alloc(Math.min(opened.stat.size, ATTACHMENT_HEADER_BYTES));
        const bytesRead = await readFileWindowFully(handle, header, 0);
        assertCurrent();
        classification = await classifyAttachmentBytes({
          buffer: header.subarray(0, bytesRead),
          declaredMime: fact.contentType,
          name: path.basename(opened.realPath),
        });
        assertCurrent();
      }
      assertCurrent();
      if (
        ["image", "audio", "video"].includes(classification.class) ||
        (limits.allowedMimesConfigured &&
          (!classification.mime || !limits.allowedMimes.has(classification.mime)))
      ) {
        continue;
      }
      const file = {
        reference: ref.raw,
        path: opened.realPath,
        ...(fact.fileName ? { name: fact.fileName } : {}),
      };
      metadataChars += JSON.stringify(file).length + 1;
      if (metadataChars > maxChars) {
        break;
      }
      files.push(file);
    } catch {
      // An unavailable input keeps its extraction outcome; cancellation must still stop dispatch.
      assertCurrent();
    }
  }
  assertCurrent();
  const note = files.length
    ? [
        "For file tools, use the verified attachment paths below. Media references identify attachments; they are not filesystem paths.",
        // Keep metadata from requesting skills/plugins while preserving decoded file identities.
        wrapExternalContent(
          JSON.stringify(files).replaceAll("$", "\\u0024").replaceAll("@", "\\u0040"),
          {
            source: "unknown",
            includeWarning: false,
          },
        ),
      ].join("\n")
    : undefined;
  if (metadataChars > maxChars || (note && note.length > maxChars)) {
    // Optional path metadata must not prevent the admitted request from running.
    return undefined;
  }
  return note;
}
