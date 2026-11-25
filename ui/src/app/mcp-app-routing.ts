import { parseMcpAppLink, mcpAppRouteSearch } from "../lib/mcp-app-route.ts";
import type { ApplicationContext } from "./context.ts";

export function navigateMcpAppLink(
  context: Pick<ApplicationContext, "navigate">,
  url: string,
): boolean {
  const target = parseMcpAppLink(url);
  if (!target) {
    return false;
  }
  context.navigate("apps", { search: mcpAppRouteSearch(target) });
  return true;
}
