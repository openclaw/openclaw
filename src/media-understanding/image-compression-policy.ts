import {
  resolveModelAwareImageCompressionPolicy,
  type ImageCompressionModelCandidate,
} from "../agents/image-compression-policy.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageCompressionPolicy } from "../media/web-media.js";

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
