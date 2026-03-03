import { resolveEnvApiKey } from "../../agents/model-auth.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { buildTalkConfigResponse } from "../../config/talk.js";
import {
  AUTO_AUDIO_KEY_PROVIDERS,
  DEFAULT_AUDIO_MODELS,
} from "../../media-understanding/defaults.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/providers/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkConfigParams,
  validateTalkModeParams,
  validateTalkTranscribeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const configPayload: Record<string, unknown> = {};

    const talkSource = includeSecrets
      ? snapshot.config.talk
      : redactConfigObject(snapshot.config.talk);
    const talk = buildTalkConfigResponse(talkSource);
    if (talk) {
      configPayload.talk = talk;
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
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
  "talk.transcribe": async ({ params, respond }) => {
    if (!validateTalkTranscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcribe params: ${formatValidationErrors(validateTalkTranscribeParams.errors)}`,
        ),
      );
      return;
    }

    const { audio, mime, language } = params as {
      audio: string;
      mime?: string;
      language?: string;
    };

    let buffer: Buffer;
    try {
      buffer = Buffer.from(audio, "base64");
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid base64 audio"));
      return;
    }
    if (buffer.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "empty audio"));
      return;
    }

    // Find the first audio provider with an available API key.
    const registry = buildMediaUnderstandingRegistry();
    let transcriptText: string | undefined;
    for (const providerId of AUTO_AUDIO_KEY_PROVIDERS) {
      const resolved = resolveEnvApiKey(providerId);
      if (!resolved?.apiKey) {
        continue;
      }
      const provider = getMediaUnderstandingProvider(providerId, registry);
      if (!provider?.transcribeAudio) {
        continue;
      }
      try {
        const result = await provider.transcribeAudio({
          buffer,
          fileName: "audio.wav",
          mime: mime ?? "audio/wav",
          apiKey: resolved.apiKey,
          model: DEFAULT_AUDIO_MODELS[providerId],
          language,
          timeoutMs: 30_000,
        });
        transcriptText = result.text;
        break;
      } catch (err) {
        // Try next provider on failure.
        continue;
      }
    }

    if (transcriptText === undefined) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "no audio transcription provider available (set OPENAI_API_KEY, GROQ_API_KEY, or DEEPGRAM_API_KEY)",
        ),
      );
      return;
    }

    respond(true, { text: transcriptText }, undefined);
  },
};
