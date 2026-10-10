import { html } from "lit";
import { createMemo } from "solid-js";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRosterActivity } from "../../lib/reactive/domain-capabilities.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { AgentsHomeView } from "./view.tsx";

export function AgentsHomePage(props: { active?: boolean }) {
  const context = useApplication();
  const store = rosterActivityStore(context);
  const roster = projectRosterActivity(store);
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const snapshot = createMemo(
    (
      previous:
        | {
            roster: typeof store.snapshot;
            gateway: typeof context.gateway.snapshot;
            defaultId: string | undefined;
          }
        | undefined,
    ) =>
      props.active === false && previous
        ? previous
        : {
            roster: roster.read(),
            gateway: gateway.read().snapshot,
            defaultId: agents.read().agentsList?.defaultId,
          },
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
      connected={snapshot().gateway.phase === "connected"}
      loading={snapshot().roster.loading}
      error={snapshot().roster.error ?? snapshot().roster.subscriptionError}
      onRetry={() => void store.refresh()}
      canCreate={canCallGatewayMethod(snapshot().gateway, "openclaw.chat", "operator.admin")}
    />
  );
}

export const header = true;
export const render = () => html`<openclaw-agents-home-page></openclaw-agents-home-page>`;

defineSolidBridge("openclaw-agents-home-page", AgentsHomePage);
