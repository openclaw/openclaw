import { definePage, redirect } from "@openclaw/uirouter";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { selectedHomeTarget } from "../../lib/sessions/home-session.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";

/** Shipped bookmarks/native URLs only. Visiting a URL never creates an agent. */
export const page = definePage({
  ...routePageSpec("custodian"),
  loader: async (context: ApplicationContext, { signal }) => {
    await waitForGatewayClient(context.gateway, signal);
    await context.agents.ensureList();
    signal.throwIfAborted();
    const target = selectedHomeTarget(context);
    const roster = context.agents.state.agentsList;
    const agent = roster?.agents.find((candidate) => candidate.id === target.agentId);
    if (
      context.gateway.snapshot.phase === "connected" &&
      roster &&
      !agent?.model?.primary?.trim() &&
      hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)
    ) {
      return redirect({
        pathname: pathForRoute("model-setup", context.basePath),
        search: "?firstRun=1",
        hash: "",
      });
    }
    return redirect({
      ...sessionNavigationTarget({ context, face: "chat", ...target, focusComposer: true }).options,
      search: "",
      hash: "",
    });
  },
  component: async () => ({ renderSolid: () => null }),
});
