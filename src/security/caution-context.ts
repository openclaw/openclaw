import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "../agents/pi-model-discovery.js";
import type { CautionConfig } from "../config/types.tools.js";

export type CautionContext = {
  cautionConfig: CautionConfig;
  auditorOptions: { model: string; timeoutMs: number; failMode: string };
  getOriginalUserMessage: () => string;
  isCautionTainted: () => boolean;
  getLastCautionedToolName: () => string;
  setCautionTaint: (toolName: string) => void;
  clearCautionTaint: () => void;
  onAuditBlock: (toolName: string, reason?: string) => void;
  // Model and registry for the auditor to use
  auditorModel: Model<Api>;
  modelRegistry: ModelRegistry;
};

export function createCautionContext(params: {
  config: { tools?: { caution?: CautionConfig } };
  originalUserMessage: string;
  auditorModel: Model<Api>;
  modelRegistry: ModelRegistry;
  onBlock?: (toolName: string, reason?: string) => void;
}): CautionContext | undefined {
  const cautionConfig = params.config?.tools?.caution;
  if (!cautionConfig || cautionConfig.enabled === false) {
    return undefined; // caution mode disabled — skip entirely
  }

  let lastCautionedToolName: string | undefined;

  return {
    cautionConfig,
    auditorOptions: {
      model: cautionConfig.auditor?.model ?? "fast",
      timeoutMs: cautionConfig.auditor?.timeoutMs ?? 3000,
      failMode: cautionConfig.auditor?.failMode ?? "block",
    },
    getOriginalUserMessage: () => params.originalUserMessage,
    isCautionTainted: () => lastCautionedToolName !== undefined,
    getLastCautionedToolName: () => lastCautionedToolName ?? "unknown",
    setCautionTaint: (name) => {
      lastCautionedToolName = name;
    },
    clearCautionTaint: () => {
      lastCautionedToolName = undefined;
    },
    onAuditBlock: (toolName, reason) => {
      params.onBlock?.(toolName, reason);
    },
    auditorModel: params.auditorModel,
    modelRegistry: params.modelRegistry,
  };
}
