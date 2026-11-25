import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { leaseMcpAppModelContextForSessionTurn } from "../../agents/mcp-ui-resource.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { CurrentTurnImages } from "./current-turn-images.js";

export type AppContextTurnParams = AgentTurnParams & {
  mcpAppContextLease?: NonNullable<
    Awaited<ReturnType<typeof leaseMcpAppModelContextForSessionTurn>>
  >;
};

export function applyMcpAppModelContext(
  params: AppContextTurnParams,
  currentTurnImages: CurrentTurnImages,
): { params: AppContextTurnParams; currentTurnImages: CurrentTurnImages } {
  const appContext = params.mcpAppContextLease;
  if (!appContext) {
    return { params, currentTurnImages };
  }
  appContext.assertCurrent();
  const existingImages = currentTurnImages.images ?? [];
  // Project indices only after current-turn image admission owns their order.
  const input = appContext.project(existingImages.length);
  const nextParams = {
    ...params,
    followupRun: {
      ...params.followupRun,
      currentInboundContext: appendCurrentInboundContext(
        params.followupRun.currentInboundContext,
        [input.context],
        input.legacyText,
      ),
    },
  };
  let nextImages = currentTurnImages;
  const appended = input.images;
  if (appended.length) {
    nextImages = {
      ...currentTurnImages,
      images: [...existingImages, ...appended],
      imageOrder: [
        ...(currentTurnImages.imageOrder ?? existingImages.map(() => "inline" as const)),
        ...appended.map(() => "inline" as const),
      ],
      ...(currentTurnImages.mediaImageLayout
        ? {
            mediaImageLayout: {
              ...currentTurnImages.mediaImageLayout,
              slots: [
                ...currentTurnImages.mediaImageLayout.slots,
                ...appended.map(() => ({ kind: "inline" as const })),
              ],
            },
          }
        : {}),
    };
  }
  return { params: nextParams, currentTurnImages: nextImages };
}
