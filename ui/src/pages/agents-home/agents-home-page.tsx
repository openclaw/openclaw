import { createMemo } from "solid-js";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRosterActivity } from "../../lib/reactive/domain-capabilities.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { AgentsHomeView } from "./view.tsx";

function AgentsHomePageContent(props: { active: boolean }) {
  const context = useApplication();
  const store = rosterActivityStore(context);
  const roster = projectRosterActivity(store);
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const snapshot = createParkedProjection(
    () => {
      const currentGateway = gateway.read().snapshot;
      return {
        roster: roster.read(),
        defaultId: agents.read().agentsList?.defaultId,
        connected: currentGateway.phase === "connected",
        canCreate: canCallGatewayMethod(currentGateway, "openclaw.chat", "operator.admin"),
      };
    },
    () => props.active,
  );
  const cards = createMemo(() => {
    const defaultId = snapshot().defaultId;
    return snapshot()
      .roster.cards.map((card) =>
        Object.assign({}, card, {
          target: sessionNavigationTarget({
            context,
            face: "chat",
            sessionKey: card.mainKey,
            agentId: card.id,
          }),
        }),
      )
      .toSorted(
        (a, b) =>
          Number(b.activeNow) - Number(a.activeNow) ||
          b.lastActiveAt - a.lastActiveAt ||
          Number(b.id === defaultId) - Number(a.id === defaultId) ||
          a.id.localeCompare(b.id),
      );
  });
  return (
    <AgentsHomeView
      cards={cards()}
      context={context}
      connected={snapshot().connected}
      loading={snapshot().roster.loading}
      error={snapshot().roster.error ?? snapshot().roster.subscriptionError}
      onRetry={() => void store.refresh()}
      canCreate={snapshot().canCreate}
    />
  );
}

export const AgentsHomePage = defineSolidBridge(
  "openclaw-agents-home-page",
  AgentsHomePageContent,
  { properties: { active: { default: true, attribute: false } } },
);
