// Narrow plugin-sdk surface for the bundled executorch plugin.
// Keep this list additive and scoped to symbols used under extensions/executorch.

export type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "../media-understanding/types.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export type { OpenClawPluginApi, PluginLogger } from "../plugins/types.js";
