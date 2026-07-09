import { resolveModelAwareImageCompressionPolicy } from "../agents/image-compression-policy.js";
import type { ImageCompressionModelCandidate } from "../agents/image-compression-policy.types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageCompressionPolicy } from "../media/web-media.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

// Image descriptions can shrink oversized originals before provider execution;
// keep source reads bounded, then enforce the provider maxBytes after compression.
const IMAGE_DESCRIPTION_PRE_COMPRESSION_MAX_BYTES = DEFAULT_MAX_BYTES.video;

export function resolveImageDescriptionPreCompressionMaxBytes(maxBytes: number): number {
  return Math.max(maxBytes, IMAGE_DESCRIPTION_PRE_COMPRESSION_MAX_BYTES);
}

/** Resolves media-understanding image compression from selected model metadata and user config. */
export async function resolveImageDescriptionCompressionPolicy(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  modelCandidates?: readonly ImageCompressionModelCandidate[];
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ImageCompressionPolicy | undefined> {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  const modelCandidates =
    params.modelCandidates ?? (provider && model ? [{ provider, model }] : []);
  return await resolveModelAwareImageCompressionPolicy({
    cfg: params.cfg,
    modelCandidates,
    imageCount: 1,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    includeConfiguredMaxSide: true,
    includeImageCountWithoutPolicy: false,
    preserveEmptyModelPolicies: false,
  });
}
