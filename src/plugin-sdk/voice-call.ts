// Narrow plugin-sdk surface for the bundled voice-call plugin.
// Keep this list additive and scoped to symbols used under extensions/voice-call.

export { definePluginEntry } from "./core.js";
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";
export { resolveOpenAITtsInstructions } from "../tts/tts-core.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { SessionEntry } from "../config/sessions/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { sleep } from "../utils.js";
