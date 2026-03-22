import type { JitsiBridgePromptConfig } from "./downstream-config.js";
import { DEFAULT_JITSI_BRIDGE_DOWNSTREAM_CONFIG } from "./downstream-config.js";

function applyTemplate(template: string, params: { roomId: string; briefing: string }): string {
  return template
    .replaceAll("{{roomId}}", params.roomId)
    .replaceAll("{{briefing}}", params.briefing);
}

export function buildBridgePrompt(params: {
  briefing?: string;
  roomId: string;
  promptConfig?: JitsiBridgePromptConfig;
}): string {
  const promptConfig = params.promptConfig || DEFAULT_JITSI_BRIDGE_DOWNSTREAM_CONFIG.prompt;
  const briefingText = params.briefing?.trim() || "";
  const briefingBlock = briefingText
    ? applyTemplate(promptConfig.briefingTemplate, {
        roomId: params.roomId,
        briefing: briefingText,
      })
    : applyTemplate(promptConfig.noBriefingTemplate, { roomId: params.roomId, briefing: "" });
  return [...promptConfig.baseInstructions, briefingBlock].join("\n\n");
}
