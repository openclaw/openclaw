// Private helper surface for the bundled ElevenLabs speech plugin.
// Keep this surface narrow and limited to config/doctor compatibility.

export {
  ELEVENLABS_TALK_PROVIDER_ID,
  ELEVENLABS_TALK_LEGACY_CONFIG_RULES,
  hasLegacyTalkFields,
  legacyConfigRules,
  migrateElevenLabsLegacyTalkConfig,
  normalizeCompatibilityConfig,
} from "../../extensions/elevenlabs/contract-api.js";
