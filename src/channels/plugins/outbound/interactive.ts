import {
  renderInteractiveCommandFallback,
  type InteractiveReply,
  type InteractiveReplyBlock,
} from "../../../interactive/payload.js";
import type { ChannelCapabilities } from "../types.core.js";

export type InteractiveReplyProjection = {
  interactive?: InteractiveReply;
  fallbackText?: string;
  degraded: boolean;
  mode: "cards" | "widgets" | "text";
};

export function reduceInteractiveReply<TState>(
  interactive: InteractiveReply | undefined,
  initialState: TState,
  reduce: (state: TState, block: InteractiveReplyBlock, index: number) => TState,
): TState {
  let state = initialState;
  for (const [index, block] of (interactive?.blocks ?? []).entries()) {
    state = reduce(state, block, index);
  }
  return state;
}

function buildProjectionFallbackText(params: {
  interactive?: InteractiveReply;
  allowCommandFallback: boolean;
}): string | undefined {
  const parts: string[] = [];
  const explicitFallback = params.interactive?.fallbackText?.trim();
  if (explicitFallback) {
    parts.push(explicitFallback);
  }
  if (params.allowCommandFallback) {
    const commandFallback = renderInteractiveCommandFallback(params.interactive)?.trim();
    if (commandFallback && !parts.includes(commandFallback)) {
      parts.push(commandFallback);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

export function projectInteractiveReplyForCapabilities(params: {
  interactive?: InteractiveReply;
  capabilities?: Pick<ChannelCapabilities, "richReplies"> | null;
}): InteractiveReplyProjection {
  const interactive = params.interactive;
  if (!interactive) {
    return {
      interactive: undefined,
      fallbackText: undefined,
      degraded: false,
      mode: "text",
    };
  }

  const richReplies = params.capabilities?.richReplies;
  const canRenderCards = richReplies?.cards === true;
  const canRenderButtons = canRenderCards || richReplies?.buttons === true;
  const canRenderSelects = canRenderCards || richReplies?.selects === true;
  const allowCommandFallback = richReplies?.commandFallback === true;
  const mode: InteractiveReplyProjection["mode"] = canRenderCards
    ? "cards"
    : canRenderButtons || canRenderSelects
      ? "widgets"
      : "text";

  const projectedBlocks: InteractiveReplyBlock[] = [];
  let degraded = false;

  for (const block of interactive.blocks) {
    if (block.type === "text") {
      projectedBlocks.push(block);
      continue;
    }
    if (block.type === "buttons") {
      if (canRenderButtons) {
        projectedBlocks.push(block);
        continue;
      }
      if (canRenderSelects && block.buttons.length > 0) {
        degraded = true;
        projectedBlocks.push({
          type: "select",
          options: block.buttons.map((button) => ({
            label: button.label,
            value: button.value,
            actionId: button.actionId,
            description: button.description,
            fallback: button.fallback,
          })),
        });
        continue;
      }
      degraded = true;
      continue;
    }

    if (canRenderSelects) {
      projectedBlocks.push(block);
      continue;
    }
    if (canRenderButtons && block.options.length > 0) {
      degraded = true;
      projectedBlocks.push({
        type: "buttons",
        buttons: block.options.map((option) => ({
          label: option.label,
          value: option.value,
          actionId: option.actionId,
          description: option.description,
          fallback: option.fallback,
        })),
      });
      continue;
    }
    degraded = true;
  }

  const fallbackText = buildProjectionFallbackText({
    interactive,
    allowCommandFallback,
  });

  if (degraded && fallbackText) {
    const lastText = projectedBlocks.at(-1);
    if (lastText?.type !== "text" || lastText.text.trim() !== fallbackText) {
      projectedBlocks.push({ type: "text", text: fallbackText });
    }
  }

  if (projectedBlocks.length === 0 && fallbackText) {
    projectedBlocks.push({ type: "text", text: fallbackText });
  }

  return {
    interactive:
      projectedBlocks.length > 0 || fallbackText
        ? {
            blocks: projectedBlocks,
            ...(fallbackText ? { fallbackText } : {}),
          }
        : undefined,
    fallbackText,
    degraded,
    mode,
  };
}
