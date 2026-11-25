import { render } from "@solidjs/web";
import { For, createSignal } from "solid-js";
import type { ClawHubRecommendation } from "../../../src/shared/clawhub-recommendations.js";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { observe, publish } from "./control-ui-card-resource-shared.ts";
import {
  instanceAssert as assert,
  instanceGateway,
  instanceSettle as settle,
  instanceWait as wait,
  type InstanceContext,
} from "./control-ui-instance-resource-fixture.ts";
function pluginResult(id: string, name: string, installed = false) {
  return {
    plugin: {
      id,
      catalog: { name, summary: "Synthetic benchmark recommendation", official: true },
      local: { installed, action: installed ? "manage" : "install" },
    },
  };
}

export async function createInstanceConsumers(context: InstanceContext) {
  const { ChatClawHubCard } = await import("../pages/chat/components/chat-clawhub-card.tsx");
  const unmounts: Array<() => void> = [];
  const rendered: HTMLElement[] = [];
  const retainOne: Array<() => void> = [];
  const id = (label: string) => `synthetic-instance-${label}`;
  instanceGateway().setRequestHandler("plugins.catalog.get", ({ params, respond }) => {
    assert(
      params && typeof params === "object" && "id" in params && typeof params.id === "string",
      "Catalog request has no ID",
    );
    respond(
      pluginResult(params.id, `${params.id.endsWith("A") ? "A" : "B"} accepted synthetic plugin`),
    );
  });
  return {
    async setup() {
      for (const [label, count] of [
        ["A", 100],
        ["B", 30],
      ] as const) {
        const group = await context.group(label, count);
        observe(context, group);
        context.capture(`${label}:before-consumers`);
        const [indices, setIndices] = createSignal(
          Array.from({ length: count }, (_, index) => index),
        );
        retainOne.push(() => setIndices((current) => current.slice(0, 1)));
        const recommendation: ClawHubRecommendation = {
          type: "clawhub",
          kind: "plugin",
          id: id(label),
          name: `${label} synthetic plugin`,
          description: "Synthetic resource fixture",
          official: true,
          installed: false,
        };
        const unmount = render(
          () => (
            <ApplicationProvider value={group.runtime.context} host={group.root}>
              <For each={indices()}>
                {() => <ChatClawHubCard recommendation={recommendation} agentId="main" />}
              </For>
            </ApplicationProvider>
          ),
          group.root,
        );
        unmounts.push(unmount);
        context.stop.push(unmount);
        await wait(
          () => group.root.querySelectorAll(".chat-clawhub-card__install").length === count,
          "Real lazy ClawHub bodies did not accept catalog results",
        );
        context.recordMounted(
          group,
          group.root.querySelectorAll("openclaw-chat-clawhub-card").length,
        );
        rendered.push(...group.root.querySelectorAll<HTMLElement>("openclaw-chat-clawhub-card"));
        context.capture(`${label}:ready-ClawHub-cards`);
      }
      return context.result();
    },
    async run() {
      const other = context.groups[1]!.root.innerHTML;
      const requests = instanceGateway().findRequests("plugins.catalog.get").length;
      await publish(context);
      assert(
        rendered.every((node) => node.isConnected),
        "ClawHub snapshots replaced card identities",
      );
      assert(context.groups[1]!.root.innerHTML === other, "A snapshot changed B's ClawHub result");
      assert(
        instanceGateway().findRequests("plugins.catalog.get").length === requests,
        "Unrelated native snapshots reloaded ClawHub status",
      );
      context.facts.assertions.push(
        "100 A / 30 B real lazy ClawHub card renderers;20 unrelated native A snapshots with retained nodes, independent B and no new catalog reads",
      );
      return context.result();
    },
    async finish() {
      const a = context.groups[0]!;
      const native = instanceGateway();
      const requests = native.findRequests("plugins.catalog.get", { id: id("A") }).length;
      native.deferNext("plugins.catalog.get", { id: id("A") });
      window.dispatchEvent(new Event("focus"));
      await wait(
        () => native.findRequests("plugins.catalog.get", { id: id("A") }).length > requests,
        "Real focus did not refresh ClawHub cards",
      );
      context.capture("focus-refresh-pending");
      a.runtime.context.gateway.stop();
      assert(
        a.runtime.context.gateway.snapshot.phase !== "connected",
        "Native ClawHub Gateway stop did not revoke admission",
      );
      native.resolveDeferred(
        "plugins.catalog.get",
        pluginResult(id("A"), "RETIRED CLAWHUB RESULT", true),
        { match: { id: id("A") } },
      );
      await settle();
      assert(
        !a.root.textContent?.includes("RETIRED CLAWHUB RESULT"),
        "Retired ClawHub status reached the UI",
      );
      a.runtime.context.gateway.start();
      await wait(
        () =>
          a.runtime.context.gateway.snapshot.phase === "connected" &&
          a.root.querySelectorAll(".chat-clawhub-card__install").length === a.count,
        "Current native ClawHub reconnect did not recover status",
      );
      context.capture("current-ClawHub-reconnected");
      retainOne[0]!();
      await wait(
        () => a.root.querySelectorAll("openclaw-chat-clawhub-card").length === 1,
        "ClawHub did not retire sibling cards",
      );
      const oneBefore = native.findRequests("plugins.catalog.get", { id: id("A") }).length;
      window.dispatchEvent(new Event("focus"));
      await wait(
        () => native.findRequests("plugins.catalog.get", { id: id("A") }).length === oneBefore + 1,
        "Remaining ClawHub card lost its shared native subscription",
      );
      context.capture("one-A-and-all-B-remain");
      unmounts[0]!();
      await settle();
      assert(
        context.groups[1]!.root.querySelectorAll(".chat-clawhub-card__install").length === 30,
        "ClawHub A cleanup retired B",
      );
      context.capture("retired-A");
      const bBefore = native.findRequests("plugins.catalog.get", { id: id("B") }).length;
      window.dispatchEvent(new Event("focus"));
      await wait(
        () => native.findRequests("plugins.catalog.get", { id: id("B") }).length > bBefore,
        "Remaining ClawHub application lost its live focus subscription",
      );
      unmounts[1]!();
      await settle();
      context.capture("retired-all");
      const counts = context.probe?.sources.snapshot();
      if (counts) {
        assert(
          Object.values(counts.sources).every((source) => source.active === 0),
          "Native ClawHub subscriptions survived final consumer disposal",
        );
      }
      context.facts.assertions.push(
        "Real focus refresh, native disconnect/reconnect, transport response retirement and independent application cleanup (consumer-level late fulfillment remains a unit-test contract)",
      );
      return context.result();
    },
  };
}
