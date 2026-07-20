import { normalizeBoardSessionKeyForComparison } from "../../../lib/board/provider.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";

export type McpAppPinDescriptor = {
  viewId: string;
  serverName: string;
  toolName: string;
  uiResourceUri: string;
  originSessionKey: string;
  toolCallId: string;
};

export function buildMcpAppPinDescriptor(
  preview: ToolPreview,
  boardSessionKey: string,
): McpAppPinDescriptor | undefined {
  const descriptor = preview.mcpApp;
  const viewId = descriptor?.viewId?.trim();
  const serverName = descriptor?.serverName?.trim();
  const toolName = descriptor?.toolName?.trim();
  const uiResourceUri = descriptor?.uiResourceUri?.trim();
  const toolCallId = descriptor?.toolCallId?.trim();
  const originSessionKey = descriptor?.originSessionKey?.trim();
  if (
    !viewId ||
    !serverName ||
    !toolName ||
    !uiResourceUri ||
    !toolCallId ||
    !originSessionKey ||
    normalizeBoardSessionKeyForComparison(originSessionKey) !==
      normalizeBoardSessionKeyForComparison(boardSessionKey)
  ) {
    return undefined;
  }
  return {
    viewId,
    serverName,
    toolName,
    uiResourceUri,
    toolCallId,
    originSessionKey,
  };
}
