import type { FinalizedRuntimeMsgContext } from "../templating.js";

export function resolveCommandContextText(ctx: FinalizedRuntimeMsgContext): string {
  return ctx.commandText.trim();
}

export function hasExplicitCommandContextText(ctx: FinalizedRuntimeMsgContext): boolean {
  const text = resolveCommandContextText(ctx);
  return text.startsWith("/") || text.startsWith("!");
}
