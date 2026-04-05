// Internal Z.AI config seam.
// Keep load cheap for config/doctor/test code; do not route through the plugin facade.

export {
  applyZaiConfig,
  applyZaiProviderConfig,
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_COST,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_DEFAULT_MODEL_REF,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/config-api.js";
