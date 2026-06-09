// OpenAI-compatible audio speech (text-to-speech) HTTP endpoint.
// Bridges `/v1/audio/speech` requests to configured OpenClaw TTS providers and
// returns raw audio bytes with a Content-Type that matches the produced format.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../tts/provider-registry.js";
import {
  getTtsProvider,
  isTtsProviderConfigured,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  synthesizeSpeech,
} from "../tts/tts.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendInvalidRequest, sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveAgentIdForRequest,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

type OpenAiAudioSpeechHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type AudioSpeechRequest = {
  model?: unknown;
  input?: unknown;
  voice?: unknown;
  response_format?: unknown;
  speed?: unknown;
};

const DEFAULT_AUDIO_SPEECH_BODY_BYTES = 1024 * 1024;
// OpenAI caps `/v1/audio/speech` input at 4096 characters; mirror that here so
// the bridge protects gateway latency before reaching a provider.
const MAX_INPUT_CHARS = 4096;
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;
// Namespace TTS providers under `tts/` so `/v1/models` can list them without
// colliding with OpenClaw agent model ids.
const TTS_MODEL_PREFIX = "tts/";

// Response formats the OpenClaw TTS pipeline can faithfully produce, mapped to
// the Content-Type used for the produced bytes. Anything outside this set is
// rejected with 400 before synthesis so the bytes never disagree with the
// reported Content-Type.
const SUPPORTED_RESPONSE_FORMATS: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  wav: "audio/wav",
};

function coerceRequest(value: unknown): AudioSpeechRequest {
  return value && typeof value === "object" ? (value as AudioSpeechRequest) : {};
}

/** Resolve the requested provider id from an OpenAI-style `model` field. */
function resolveProviderRef(model: string): string {
  const lowered = model.toLowerCase();
  if (lowered.startsWith(TTS_MODEL_PREFIX)) {
    return model.slice(TTS_MODEL_PREFIX.length).trim();
  }
  // Treat a bare `tts` (no provider) as "use the configured default".
  if (lowered === "tts") {
    return "";
  }
  return model.trim();
}

/** Resolve the produced bytes to one of the supported short format tokens, if recognizable. */
function resolveProducedFormatToken(
  outputFormat?: string,
  fileExtension?: string,
): string | undefined {
  const normalizedFormat = outputFormat?.trim().toLowerCase();
  if (normalizedFormat && SUPPORTED_RESPONSE_FORMATS[normalizedFormat]) {
    return normalizedFormat;
  }
  const ext = fileExtension?.replace(/^\./u, "").trim().toLowerCase();
  if (ext && SUPPORTED_RESPONSE_FORMATS[ext]) {
    return ext;
  }
  return undefined;
}

/** Map a produced output format / file extension to a binary Content-Type. */
function resolveAudioContentType(outputFormat?: string, fileExtension?: string): string {
  const token = resolveProducedFormatToken(outputFormat, fileExtension);
  return token ? SUPPORTED_RESPONSE_FORMATS[token] : "application/octet-stream";
}

/** Handles OpenAI-compatible text-to-speech requests for configured TTS providers. */
export async function handleOpenAiAudioSpeechHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiAudioSpeechHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/audio/speech",
    requiredOperatorMethod: "chat.send",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_AUDIO_SPEECH_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);

  const input = typeof payload.input === "string" ? payload.input : undefined;
  if (!input) {
    sendInvalidRequest(res, "`input` is required and must be a string.");
    return true;
  }
  if (input.length > MAX_INPUT_CHARS) {
    sendInvalidRequest(res, `\`input\` too long (max ${MAX_INPUT_CHARS} characters).`);
    return true;
  }

  // `response_format` must be a format this bridge knows how to label; otherwise
  // a client could receive bytes whose Content-Type disagrees with the payload.
  const requestedFormat = normalizeOptionalString(payload.response_format)?.toLowerCase();
  if (requestedFormat && !SUPPORTED_RESPONSE_FORMATS[requestedFormat]) {
    sendInvalidRequest(
      res,
      `Unsupported \`response_format\`: ${requestedFormat}. Supported: ${Object.keys(
        SUPPORTED_RESPONSE_FORMATS,
      ).join(", ")}.`,
    );
    return true;
  }

  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdForRequest({ req, model: undefined });
  const ttsConfig = resolveTtsConfig(cfg, agentId);

  // Resolve the concrete provider so synthesis never silently falls back to a
  // different provider than the request asked for.
  const requestModel = normalizeOptionalString(payload.model) ?? "";
  const providerRef = requestModel ? resolveProviderRef(requestModel) : "";
  let providerId: string | undefined;
  if (providerRef) {
    providerId = canonicalizeSpeechProviderId(providerRef, cfg);
    if (!providerId) {
      sendInvalidRequest(res, buildUnavailableProviderMessage(providerRef, cfg, agentId));
      return true;
    }
  } else {
    providerId = getTtsProvider(ttsConfig, resolveTtsPrefsPath(ttsConfig));
  }

  if (!isTtsProviderConfigured(ttsConfig, providerId, cfg)) {
    sendInvalidRequest(
      res,
      buildUnavailableProviderMessage(providerRef || providerId, cfg, agentId),
    );
    return true;
  }

  const providerOverrides: Record<string, unknown> = {};
  const voice = normalizeOptionalString(payload.voice);
  if (voice) {
    providerOverrides.voice = voice;
  }
  if (typeof payload.speed === "number" && Number.isFinite(payload.speed)) {
    providerOverrides.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, payload.speed));
  }
  if (requestedFormat) {
    providerOverrides.responseFormat = requestedFormat;
  }

  try {
    const result = await synthesizeSpeech({
      text: input,
      cfg,
      agentId,
      disableFallback: true,
      overrides: {
        provider: providerId,
        providerOverrides: { [providerId]: providerOverrides },
      },
    });

    if (!result.success || !result.audioBuffer) {
      logWarn(`openai-compat: audio speech synthesis failed: ${result.error ?? "unknown error"}`);
      sendJson(res, 502, {
        error: {
          message: result.error ?? "Speech synthesis failed.",
          type: "api_error",
        },
      });
      return true;
    }

    // `response_format` must genuinely take effect. Some providers read a
    // different override key (e.g. `outputFormat`) and emit their own default,
    // so reject instead of silently returning a format the client did not ask
    // for. Providers that honor the override report the produced short token.
    const producedFormat = resolveProducedFormatToken(result.outputFormat, result.fileExtension);
    if (requestedFormat && producedFormat !== requestedFormat) {
      sendInvalidRequest(
        res,
        `Provider '${providerId}' does not support response_format '${requestedFormat}' ` +
          `(produced '${producedFormat ?? result.outputFormat}').`,
      );
      return true;
    }

    const contentType = resolveAudioContentType(result.outputFormat, result.fileExtension);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(result.audioBuffer.length));
    res.end(result.audioBuffer);
  } catch (err) {
    logWarn(`openai-compat: audio speech request failed: ${formatErrorMessage(err)}`);
    sendJson(res, 500, {
      error: {
        message: "internal error",
        type: "api_error",
      },
    });
  }

  return true;
}

/** List configured TTS providers as `tts/<provider>` for actionable error messages. */
function listConfiguredTtsModelIds(
  cfg: ReturnType<typeof getRuntimeConfig>,
  agentId: string,
): string[] {
  const ttsConfig = resolveTtsConfig(cfg, agentId);
  return listSpeechProviders(cfg)
    .filter((provider) => isTtsProviderConfigured(ttsConfig, provider.id, cfg))
    .map((provider) => `${TTS_MODEL_PREFIX}${provider.id}`);
}

function buildUnavailableProviderMessage(
  providerRef: string,
  cfg: ReturnType<typeof getRuntimeConfig>,
  agentId: string,
): string {
  const available = listConfiguredTtsModelIds(cfg, agentId);
  const availableText =
    available.length > 0 ? available.join(", ") : "(none — configure a TTS provider)";
  return `TTS provider '${providerRef}' is not available. Configured providers: ${availableText}.`;
}
