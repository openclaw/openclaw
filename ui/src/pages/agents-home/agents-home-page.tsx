import { createEffect, createMemo, createSignal } from "solid-js";
import { pathForClawCatalogEntry } from "../../app-route-paths.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import {
  projectAgents,
  projectRosterActivity,
  projectRuntimeConfig,
} from "../../lib/reactive/domain-capabilities.ts";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { LAB_FEATURES, resolveLabFeatureState } from "../labs/labs-registry.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";
import { ClawsCatalogDialog } from "./claws-catalog-dialog.tsx";
import { AgentsHomeView } from "./view.tsx";

const clawsLab = LAB_FEATURES.find((feature) => feature.id === "claws");

export function AgentsHomePage(props: { active?: boolean }) {
  const context = useApplication();
  const store = rosterActivityStore(context);
  const roster = projectRosterActivity(store);
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const [catalogOpen, setCatalogOpen] = createSignal(false);
  // Load Gateway runtime configuration when the retained home page becomes active.
  createEffect(
    () => props.active ?? true,
    (active) => {
      if (!active) {
        return;
      }
      void context.runtimeConfig.ensureLoaded();
    },
  );
  const snapshot = createParkedProjection(
    () => {
      const currentGateway = gateway.read().snapshot;
      return {
        roster: roster.read(),
        defaultId: agents.read().agentsList?.defaultId,
        connected: currentGateway.phase === "connected",
        canCreate: canCallGatewayMethod(currentGateway, "openclaw.chat", "operator.admin"),
        showExplore: Boolean(
          clawsLab &&
          resolveLabFeatureState(currentConfigObject(runtimeConfig.read().state), clawsLab).enabled,
        ),
      };
    },
    () => props.active ?? true,
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
  const selectClaw = (entry: ClawCatalogEntry) => {
    setCatalogOpen(false);
    context.navigate("claws", {
      pathname: pathForClawCatalogEntry(entry.packageName, context.basePath),
    });
  };
  return (
    <openclaw-agents-home-page>
      <AgentsHomeView
        cards={cards()}
        context={context}
        connected={snapshot().connected}
        loading={snapshot().roster.loading}
        error={snapshot().roster.error ?? snapshot().roster.subscriptionError}
        onRetry={() => void store.refresh()}
        canCreate={snapshot().canCreate}
        showExplore={snapshot().showExplore}
        onOpenCatalog={() => setCatalogOpen(true)}
        onSelectClaw={selectClaw}
      />
      {snapshot().showExplore && catalogOpen() ? (
        <ClawsCatalogDialog
          onSelectEntry={selectClaw}
          onClose={() => setCatalogOpen(false)}
          onAdded={() => void store.refresh()}
        />
      ) : undefined}
    </openclaw-agents-home-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agents-home-page": HTMLAttributes<HTMLElement>;
    }
  }
}
