import type { TooltipElement } from "../components/tooltip.ts";
import {
  instanceAssert as assert,
  instanceSettle as settle,
  instanceWait as wait,
  type InstanceContext,
} from "./control-ui-instance-resource-fixture.ts";
export async function createInstanceConsumers(context: InstanceContext) {
  await import("../components/tooltip.ts");
  const host = document.createElement("section");
  host.dataset.projectionApplication = "A";
  const shadowHost = document.createElement("div");
  const shadow = shadowHost.attachShadow({ mode: "open" });
  host.append(shadowHost);
  document.body.append(host);
  context.stop.push(() => host.remove());
  const rows: { tooltip: TooltipElement; trigger: HTMLButtonElement }[] = [];
  const description = (trigger: HTMLElement) => {
    const root = trigger.getRootNode();
    const id = trigger.getAttribute("aria-describedby");
    return id && (root instanceof ShadowRoot ? root : document).getElementById(id)?.textContent;
  };
  const identities: Node[] = [];
  return {
    async setup() {
      context.capture("before-consumers");
      for (let index = 0; index < 100; index++) {
        const tooltip = document.createElement("openclaw-tooltip");
        tooltip.content = `Synthetic hint ${index}`;
        tooltip.delay = 0;
        tooltip.closeDelay = 0;
        const trigger = document.createElement("button");
        trigger.textContent = `Action ${index}`;
        tooltip.append(trigger);
        (index < 50 ? host : shadow).append(tooltip);
        rows.push({ tooltip, trigger });
        identities.push(tooltip, trigger);
      }
      await Promise.all(rows.map(({ tooltip }) => tooltip.updateComplete));
      await settle();
      for (const [index, { tooltip, trigger }] of rows.entries()) {
        assert(
          description(trigger) === `Synthetic hint ${index}`,
          "Closed tooltip lost its eager description",
        );
        assert(
          !tooltip.shadowRoot?.querySelector(".tooltip-content"),
          "Closed tooltip eagerly materialized presentation",
        );
      }
      context.recordMounted(
        { label: "A", count: 100 },
        rows.filter(({ tooltip }) => tooltip.isConnected).length,
      );
      context.capture("closed-tooltips");
      return context.result();
    },
    async run() {
      for (let revision = 0; revision < 20; revision++) {
        for (const [index, row] of rows.entries()) {
          row.trigger.textContent = `Action ${index} revision ${revision}`;
        }
        await settle();
      }
      assert(
        identities.every((node) => node.isConnected),
        "Tooltip update replaced a retained row/trigger",
      );
      for (const [index, { trigger }] of rows.entries()) {
        assert(
          description(trigger) === `Synthetic hint ${index}`,
          "Tooltip update lost description",
        );
      }
      context.capture("mutated-tooltips");
      context.facts.assertions.push(
        "100 tooltip and trigger identities retained across 20 native child-list publication batches; eager descriptions intact in light and shadow DOM",
      );
      return context.result();
    },
    async finish() {
      const first = rows[0]!;
      first.trigger.focus();
      await first.tooltip.updateComplete;
      await wait(
        () =>
          first.tooltip.shadowRoot?.querySelector(".tooltip-surface")?.matches(":popover-open") ===
          true,
        "Focused tooltip did not reveal",
      );
      context.capture("one-open-tooltip");
      first.trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
      );
      await wait(() => !first.tooltip.hasAttribute("open"), "Escape did not retire tooltip");
      const old = first.trigger;
      const replacement = document.createElement("button");
      replacement.textContent = "Replacement synthetic action";
      first.tooltip.replaceChildren(replacement);
      first.trigger = replacement;
      await settle();
      assert(
        !old.hasAttribute("aria-describedby") && description(replacement) === "Synthetic hint 0",
        "Replacement trigger lost description ownership",
      );
      for (const row of rows.slice(1)) {
        row.tooltip.remove();
      }
      await settle();
      assert(
        description(replacement) === "Synthetic hint 0",
        "Sibling removal retired the remaining tooltip",
      );
      context.capture("one-tooltip-remains");
      first.tooltip.remove();
      await settle();
      assert(
        !replacement.hasAttribute("aria-describedby"),
        "Removed tooltip retained aria ownership",
      );
      context.capture("retired-all");
      const initial = context.facts.nativeCheckpoints.find(
        (row) => row.phase === "before-consumers",
      );
      const final = context.facts.nativeCheckpoints.at(-1);
      if (initial && final) {
        assert(
          final.native.observers.MutationObserver.active ===
            initial.native.observers.MutationObserver.active,
          "Tooltip observers remain active after final removal",
        );
      }
      context.facts.assertions.push(
        "One native focus reveal, Escape, trigger replacement, independent sibling removal and final observer teardown",
      );
      return context.result();
    },
  };
}
