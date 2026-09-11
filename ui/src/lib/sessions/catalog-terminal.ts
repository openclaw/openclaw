import type {
  SessionsCatalogStartTerminalParams,
  SessionsCatalogStartTerminalResult,
} from "@openclaw/gateway-protocol";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { TerminalGatewayClient } from "../../components/terminal/terminal-connection.ts";
import { catalogSessionSearch, type CatalogSessionKey } from "./catalog-key.ts";

export function openCatalogSessionInTerminal(
  key: CatalogSessionKey,
  agentId: string,
  selection: ApplicationContext["agentSelection"],
  navigate: ApplicationContext<"terminal">["navigate"],
  basePath: string,
): void {
  selection.set(agentId);
  navigate("terminal", {
    pathname: pathForRoute("terminal", basePath),
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
