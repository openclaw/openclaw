/**
 * Voice Call Plugin SDK exports
 *
 * This module provides voice call functionality for OpenClaw plugins.
 */

// Core plugin types
export type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
} from "../plugins/types.js";

export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";

// TTS schemas
export {
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";

export type { TtsAutoSchema } from "../config/zod-schema.core.js";

// Utils
export { sleep } from "../utils.js";

// Network
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

// Body limits
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";

// TTS instructions
export { resolveOpenAITtsInstructions } from "../tts/tts-core.js";
