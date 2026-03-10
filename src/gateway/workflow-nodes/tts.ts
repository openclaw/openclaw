/**
 * TTS (Text-to-Speech) Node Handler
 *
 * Converts text to speech using ElevenLabs, OpenAI, or Edge TTS
 */

import { loadConfig } from "../../config/config.js";
import {
  resolveTtsConfig,
  resolveTtsPrefsPath,
  getTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";
import { renderTemplate } from "./types.js";

export const ttsHandler: WorkflowNodeHandler = {
  actionType: "tts",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      // Render template with {{input}} replacement
      const rawText = (config.ttsText as string) || context.currentInput || "";
      const text = renderTemplate(rawText, context.currentInput, context.variables);

      if (!text) {
        return {
          status: "error",
          error: "TTS node missing text to convert",
          metadata: { nodeId, label },
        };
      }

      const provider = config.ttsProvider as string | undefined;

      // Load config and convert
      const cfg = loadConfig();
      const ttsConfig = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(ttsConfig);
      const currentProvider = getTtsProvider(ttsConfig, prefsPath);

      // Use specified provider or fall back to current
      const targetProvider = provider || currentProvider;

      // Convert text to speech
      const result = await textToSpeech({
        text,
        cfg,
        channel: targetProvider || undefined,
      });

      if (result.success && result.audioPath) {
        return {
          status: "success",
          output: result.audioPath,
          metadata: {
            nodeId,
            label,
            audioPath: result.audioPath,
            provider: result.provider,
            outputFormat: result.outputFormat,
            voiceCompatible: result.voiceCompatible,
            textLength: text.length,
          },
        };
      }

      return {
        status: "error",
        error: result.error || "TTS conversion failed",
        metadata: {
          nodeId,
          label,
          textLength: text.length,
          provider: targetProvider,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "tts",
        },
      };
    }
  },
};
