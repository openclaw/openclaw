import type {
  SessionsCatalogStartTerminalParams,
  SessionsCatalogStartTerminalResult,
} from "@openclaw/gateway-protocol";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { TerminalGatewayClient } from "../../components/terminal/terminal-connection.ts";
import { catalogSessionSearch, type CatalogSessionKey } from "./catalog-key.ts";

export function openCatalogSessionInTerminal(
  host: {
    sessionDataContext?: Pick<ApplicationContext, "agentSelection"> | null;
    onNavigate?: ApplicationContext<"terminal">["navigate"];
    basePath: string;
  },
  key: CatalogSessionKey,
  agentId: string,
): void {
  if (!host.onNavigate || !host.sessionDataContext) {
    return;
  }
  host.sessionDataContext.agentSelection.set(agentId);
  host.onNavigate("terminal", {
    pathname: pathForRoute("terminal", host.basePath),
    search: catalogSessionSearch(key),
    hash: "",
  });
}

export async function startCatalogSessionInTerminal(
  client: TerminalGatewayClient,
  params: SessionsCatalogStartTerminalParams,
  isCurrent: () => boolean,
): Promise<SessionsCatalogStartTerminalResult> {
  const { prepareCatalogTerminal } = await import("./catalog-terminal-start.ts");
  return prepareCatalogTerminal(client, params, isCurrent);
}
