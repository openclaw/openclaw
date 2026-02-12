import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkModeParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

export const talkHandlers: GatewayRequestHandlers = {
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },

  /**
   * Returns the talk-mode configuration **with the real API key**.
   *
   * Unlike `config.get` (which redacts sensitive fields for display in the
   * Web UI), this endpoint is purpose-built for device clients (macOS / iOS)
   * that need the actual credential to call the ElevenLabs API directly.
   *
   * Fixes: https://github.com/openclaw/openclaw/issues/14586
   */
  "talk.config": ({ respond }) => {
    try {
      const cfg = loadConfig();
      const talk = cfg.talk ?? {};

      const apiKey =
        talk.apiKey?.trim() ||
        process.env.ELEVENLABS_API_KEY?.trim() ||
        process.env.XI_API_KEY?.trim() ||
        undefined;

      respond(
        true,
        {
          voiceId: talk.voiceId ?? null,
          voiceAliases: talk.voiceAliases ?? {},
          modelId: talk.modelId ?? null,
          outputFormat: talk.outputFormat ?? null,
          interruptOnSpeech: talk.interruptOnSpeech ?? true,
          apiKey: apiKey ?? null,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
