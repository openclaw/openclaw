import { KIMI_CODING_MODEL_REF } from "../../extensions/kimi-coding/onboard.js";
import {
  KIMI_DEFAULT_MODEL_ID as KIMI_CODING_MODEL_ID,
  KIMI_CODING_BASE_URL,
} from "../../extensions/kimi-coding/provider-catalog.js";
import {
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_API_BASE_URL,
  MINIMAX_API_COST,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MINIMAX_LM_STUDIO_COST,
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
} from "../../extensions/minimax/model-definitions.js";
import {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "../../extensions/mistral/model-definitions.js";
import {
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_DEFAULT_COST,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  MODELSTUDIO_DEFAULT_MODEL_REF,
  MODELSTUDIO_GLOBAL_BASE_URL,
  buildModelStudioDefaultModelDefinition,
  buildModelStudioModelDefinition,
} from "../../extensions/modelstudio/model-definitions.js";
import {
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "../../extensions/moonshot/onboard.js";
import {
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
} from "../../extensions/moonshot/provider-catalog.js";
import { QIANFAN_DEFAULT_MODEL_REF } from "../../extensions/qianfan/onboard.js";
import {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "../../extensions/qianfan/provider-catalog.js";
import {
  XAI_BASE_URL,
  XAI_DEFAULT_COST,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  buildXaiModelDefinition,
} from "../../extensions/xai/model-definitions.js";
import {
  buildZaiModelDefinition,
  resolveZaiBaseUrl,
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_COST,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/model-definitions.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_MODEL_ID,
  KILOCODE_DEFAULT_MODEL_NAME,
} from "../providers/kilocode-shared.js";

export {
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_API_BASE_URL,
  MINIMAX_API_COST,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MINIMAX_LM_STUDIO_COST,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_DEFAULT_COST,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  MODELSTUDIO_DEFAULT_MODEL_REF,
  MODELSTUDIO_GLOBAL_BASE_URL,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  QIANFAN_DEFAULT_MODEL_REF,
  XAI_BASE_URL,
  XAI_DEFAULT_COST,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_COST,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_MODEL_ID,
  KIMI_CODING_MODEL_REF,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_MODEL_ID,
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  buildMistralModelDefinition,
  buildModelStudioDefaultModelDefinition,
  buildModelStudioModelDefinition,
  buildXaiModelDefinition,
  buildZaiModelDefinition,
  resolveZaiBaseUrl,
};

export function buildMoonshotModelDefinition(): ModelDefinitionConfig {
  return buildMoonshotProvider().models[0];
}

export function buildKilocodeModelDefinition(): ModelDefinitionConfig {
  return {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KILOCODE_DEFAULT_MAX_TOKENS,
  };
}
