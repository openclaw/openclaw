import type { DecisionImage } from "../../decisions/types.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import {
  loadMediaToolReferences,
  resolveMediaToolSandboxConfig,
  type MediaToolSandbox,
} from "./media-tool-shared.js";

const MAX_IMAGE_BYTES = 4 * 1_048_576;

export async function loadDecisionImages(params: {
  paths: readonly string[];
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  sandbox?: MediaToolSandbox;
  signal: AbortSignal;
}): Promise<DecisionImage[]> {
  const paths = params.paths.map((raw) => {
    const input = normalizeMediaReferenceSource(raw.trim().replace(/^@\s*/, ""));
    const source = classifyMediaReferenceSource(input);
    if (!input || source.isHttpUrl || source.isDataUrl || source.hasUnsupportedScheme) {
      throw new Error("decision_evaluate images must be local image paths.");
    }
    return input;
  });
  const sandbox = resolveMediaToolSandboxConfig(params.sandbox, params.fsPolicy?.workspaceOnly);
  const loaded = await loadMediaToolReferences({
    inputs: paths,
    toolName: "decision_evaluate",
    expectedKind: "image",
    sandbox,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    fsPolicy: params.fsPolicy,
    maxBytes: MAX_IMAGE_BYTES,
    optimizeImages: false,
    signal: params.signal,
    mapMedia: (media): DecisionImage => {
      const contentType = "mimeType" in media ? media.mimeType : media.contentType;
      if (
        contentType !== "image/png" &&
        contentType !== "image/jpeg" &&
        contentType !== "image/webp"
      ) {
        throw new Error("decision_evaluate supports PNG, JPEG, and WebP images only.");
      }
      return { mimeType: contentType, data: Uint8Array.from(media.buffer) };
    },
  });
  params.signal.throwIfAborted();
  return loaded.map(({ source }) => source);
}
