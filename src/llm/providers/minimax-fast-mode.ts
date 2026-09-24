const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);

export function resolveMinimaxFastModelId(model: {
  id: string;
  api?: string;
  provider: string;
}): string | undefined {
  return model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
    ? MINIMAX_FAST_MODEL_IDS.get(model.id.trim())
    : undefined;
}
