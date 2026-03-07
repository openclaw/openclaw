// Narrow plugin-sdk surface for the bundled voice-call plugin.
// Keep this list additive and scoped to symbols used under extensions/voice-call.

export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "../config/zod-schema.core.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { sleep } from "../utils.js";
