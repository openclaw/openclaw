import type { ActiveMediaModel } from "../../../packages/media-understanding-common/src/active-model.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaExecutionContext } from "../../media-understanding/provider-execution.js";
import type { MediaFact } from "../../media/media-facts.js";

/** Text-only agent turns share chat's image preparation while retaining their primary model. */
export async function prepareAgentImageUnderstanding(params: {
  message: string;
  media: MediaFact[];
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionKey?: string;
  channel?: string;
  chatType?: string;
  activeModel: ActiveMediaModel;
  execution?: MediaExecutionContext;
}): Promise<{ message: string; media: MediaFact[] }> {
  const { message, media, sessionKey, channel, chatType, ...runtime } = params;
  const ctx: MsgContext = {
    Body: message,
    media,
    SessionKey: sessionKey,
    AgentId: params.agentId,
    Provider: channel,
    ChatType: chatType,
  };
  const { applyMediaUnderstanding } = await import("../../media-understanding/apply.runtime.js");
  await applyMediaUnderstanding({ ...runtime, ctx });
  params.execution?.signal.throwIfAborted();
  if (
    !ctx.MediaUnderstanding?.some(
      (output) => output.kind === "image.description" && output.text.trim(),
    )
  ) {
    throw new Error(
      "Image attachments could not be analyzed. Configure agents.defaults.imageModel or tools.media.models with an available vision model, then retry.",
    );
  }
  return {
    message: ctx.agentText ?? message,
    // The pixels remain in the transcript; this text-only turn consumes the description.
    media: media.map((fact) => Object.assign({}, fact, { hydrationSuppressed: true })),
  };
}
