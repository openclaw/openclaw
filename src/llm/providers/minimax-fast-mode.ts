export function resolveMinimaxFastModelId(model: {
  id: string;
  api?: string;
  provider: string;
}): string | undefined {
  return model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal") &&
    model.id.trim() === "MiniMax-M2.7"
    ? "MiniMax-M2.7-highspeed"
    : undefined;
}
