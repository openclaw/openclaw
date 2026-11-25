import { BoardValidationError } from "../boards/board-layout.js";
import type { BoardSessionTarget, BoardStore, BoardWidgetDocument } from "../boards/board-store.js";
import { requireBoardViewTicketAuthority, verifyBoardViewTicket } from "./board-view-ticket.js";
import { prepareRemoteIngressSessionRead } from "./remote-ingress-session-read.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type AuthorizedBoardWidgetView = BoardSessionTarget & {
  name: string;
  document: Extract<BoardWidgetDocument, { html: string }>;
};

export async function withAuthorizedBoardWidgetView<T>(
  store: BoardStore,
  ticket: string,
  consume: (view: AuthorizedBoardWidgetView) => T,
  options: { gatewayContext?: GatewayRequestContext; nowMs?: number } = {},
): Promise<Awaited<T>> {
  const claims = verifyBoardViewTicket(ticket, options);
  if (!claims) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is invalid");
  }
  const source = requireBoardViewTicketAuthority(claims, options.gatewayContext);
  using ingressRead = await prepareRemoteIngressSessionRead(
    source.remoteIngressPrincipal,
    claims.sessionKey,
    claims.agentId,
  );
  const session = { sessionKey: claims.sessionKey, agentId: claims.agentId };
  return await store.useWidgetDocument(session, claims.name, (document) => {
    requireBoardViewTicketAuthority(claims, options.gatewayContext);
    ingressRead.assertCurrent();
    if (claims.expiresAtMs <= (options.nowMs ?? Date.now())) {
      throw new BoardValidationError("invalid_operation", "board widget view ticket is expired");
    }
    if (
      !document ||
      !("viewGeneration" in document) ||
      (document.grantState !== "none" && document.grantState !== "granted") ||
      document.revision !== claims.revision ||
      document.viewGeneration !== claims.viewGeneration
    ) {
      throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
    }
    if (!("html" in document)) {
      throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");
    }
    return consume({ ...session, name: claims.name, document });
  });
}
