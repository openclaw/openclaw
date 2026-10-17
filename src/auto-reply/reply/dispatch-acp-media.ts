import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { loadAgentTurnMediaRuntime } from "./agent-turn-attachments.js";
import { hasInboundMediaForUnderstanding } from "./inbound-media.js";

export async function prepareAcpMediaUnderstanding(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  attachmentIndexes?: number[];
  extractedFileImages?: ExtractedFileImage[];
  signal?: AbortSignal;
}): Promise<ExtractedFileImage[]> {
  let extractedFileImages = params.extractedFileImages ?? [];
  if (hasInboundMediaForUnderstanding(params.ctx) && !params.ctx.MediaUnderstanding?.length) {
    try {
      const { applyMediaUnderstanding } = await loadAgentTurnMediaRuntime();
      params.signal?.throwIfAborted();
      const mediaResult = await applyMediaUnderstanding({
        ctx: params.ctx,
        cfg: params.cfg,
        deliveredImageIndexes: new Set(params.attachmentIndexes ?? []),
        agentId: params.agentId,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
        signal: params.signal,
      });
      if (mediaResult.extractedFileImages.length > 0) {
        extractedFileImages = [...extractedFileImages, ...mediaResult.extractedFileImages];
      }
    } catch (err) {
      params.signal?.throwIfAborted();
      logVerbose(
        `dispatch-acp: media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
      );
    }
  }
  params.signal?.throwIfAborted();
  return extractedFileImages;
}
