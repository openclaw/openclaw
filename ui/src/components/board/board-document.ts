import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { BoardDocument, type BoardDocumentProps } from "./board-document.tsx";

export const OpenClawBoardDocument = defineSolidBridge<BoardDocumentProps>(
  "openclaw-board-document",
  BoardDocument,
  {
    properties: {
      gatewaySnapshot: { default: undefined, attribute: false },
      sessions: { default: undefined, attribute: false },
      sessionKey: { default: null, attribute: false },
      preparedSession: { default: null, attribute: false },
      onDocumentClose: { default: null, attribute: false },
      passive: { default: false, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-document": SolidBridgeElement<BoardDocumentProps>;
  }
}
