/**
 * Dependency-light realtime-voice activation-name helpers.
 *
 * Doctor contract closures (e.g. Discord's wake-name migrations) need these
 * pure helpers; the broad `realtime-voice` barrel also value-loads the agent
 * consult runtime and session graphs, which enumeration must not cold-load.
 */
export {
  isSupportedRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
} from "../talk/activation-name.js";
