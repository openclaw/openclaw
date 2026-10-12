import { solidContent } from "../../../lit/solid-content.tsx";
import type { PositionRailParams } from "./chat-position-rail-controller.ts";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";

/** Remaining Lit callers use the same mounted Solid rail. */
export function renderChatPositionRail(
  params: PositionRailParams & { requestUpdate?: () => void },
) {
  return solidContent(ChatPositionRail, params);
}
