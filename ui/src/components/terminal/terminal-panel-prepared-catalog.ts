import { takePreparedCatalogTerminal } from "../../lib/sessions/catalog-terminal-start.ts";
import type { TerminalConnection, TerminalGatewayClient } from "./terminal-connection.ts";

export function claimCatalog(
  page: boolean,
  sessionId: string,
  client: TerminalGatewayClient,
  connection: TerminalConnection | null,
) {
  const prepared = page ? takePreparedCatalogTerminal(sessionId, client) : null;
  if (!prepared) {
    return { connection, prepared };
  }
  connection?.dispose();
  return { connection: prepared.connection, prepared };
}

export async function restoredSessionGone(
  connection: TerminalConnection,
  sessionId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const sessions = await connection.list().catch(() => null);
  return (
    sessions !== null && isCurrent() && !sessions.some((session) => session.sessionId === sessionId)
  );
}
