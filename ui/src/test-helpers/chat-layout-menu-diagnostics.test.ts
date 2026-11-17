import { afterEach, expect, it } from "vitest";
import { observeChatLayoutMenu } from "./chat-layout-menu-diagnostics.ts";

const observations: NonNullable<ReturnType<typeof observeChatLayoutMenu>>[] = [];
afterEach(() => {
  observations.splice(0).forEach((observation) => observation.stop());
  document.body.replaceChildren();
});

function fixture() {
  const pane = document.createElement("openclaw-chat-pane");
  const host = document.createElement("div");
  host.className = "chat-dashboard-menu";
  // These attributes/text must never reach the public failure facts.
  host.innerHTML = `<button data-part="trigger" aria-expanded="true" title="private-title"></button>
    <div class="oc-menu" id="private-id" data-phase="opening" data-state="open">
      <button data-value="dashboard-expand">private-label</button>
    </div>`;
  pane.append(host);
  document.body.append(pane);
  const surface = host.querySelector(".oc-menu")!;
  const trigger = host.querySelector("[data-part=trigger]")!;
  const item = host.querySelector("[data-value]")!;
  const observation = observeChatLayoutMenu(host)!;
  observations.push(observation);
  return { pane, host, surface, trigger, item, observation };
}

it("orders selection, veto, synchronous phases and same-ID host replacement without content", async () => {
  const { pane, host, surface, trigger, item, observation } = fixture();
  item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 30 }));
  item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  item.addEventListener("click", () => {
    surface.addEventListener("overlay-hide", (event) => event.preventDefault(), { once: true });
    surface.dispatchEvent(new CustomEvent("overlay-hide", { bubbles: true, cancelable: true }));
    surface.dispatchEvent(new CustomEvent("menu-select", { bubbles: true, cancelable: true }));
    surface.setAttribute("data-phase", "closing");
    surface.setAttribute("data-phase", "hidden");
    trigger.setAttribute("aria-expanded", "false");
  });
  item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const replacement = host.cloneNode(true);
  host.replaceWith(replacement);
  await Promise.resolve();
  const newSurface = pane.querySelector(".oc-menu")!;
  newSurface.dispatchEvent(new CustomEvent("overlay-show", { bubbles: true, cancelable: true }));
  newSurface.setAttribute("data-phase", "opening");
  newSurface.setAttribute("data-phase", "open");
  pane
    .querySelector("[data-part=trigger]")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await Promise.resolve();

  const facts = observation.read();
  const types = facts.events.map((event) => event.type);
  expect(types.slice(0, 6)).toEqual([
    "start",
    "pointerdown",
    "pointerup",
    "click",
    "overlay-hide",
    "menu-select",
  ]);
  expect(facts.events.find((event) => event.type === "overlay-hide")).toMatchObject({
    prevented: true,
  });
  expect(
    facts.events
      .filter((event) => event.type === "attribute" && event.attribute === "data-phase")
      .map((event) => event.oldValue),
  ).toEqual(["opening", "closing", "hidden", "opening"]);
  expect(facts.events.filter((event) => event.type === "removed")).toContainEqual(
    expect.objectContaining({
      target: expect.objectContaining({ node: facts.original?.node, connected: false }),
    }),
  );
  const currentHost = facts.current.find((node) => node?.kind === "host");
  expect(currentHost?.node).not.toBe(facts.original?.node);
  expect(facts.events.at(-1)).toMatchObject({
    type: "click",
    target: { kind: "trigger", host: currentHost?.node },
  });
  expect(JSON.stringify(facts)).not.toContain("private-");
});

it("retains detached surface identity, bounds events, and stops observing", async () => {
  const { surface, item, observation } = fixture();
  const originalSurface = observation.read().current.find((node) => node?.kind === "surface");
  surface.remove();
  await Promise.resolve();
  expect(observation.read().events).toContainEqual(
    expect.objectContaining({
      type: "removed",
      target: expect.objectContaining({
        node: originalSurface?.node,
        host: originalSurface?.host,
        connected: false,
      }),
    }),
  );
  // A release outside the retired owner must be visible in the chronology too.
  for (let index = 0; index < 205; index += 1) {
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  }
  const facts = structuredClone(observation.read());
  expect(facts.events).toHaveLength(200);
  expect(facts.dropped).toBeGreaterThan(0);
  expect(facts.events.at(-1)).toMatchObject({ type: "pointerup", target: { kind: "outside" } });
  observation.stop();
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  item.setAttribute("data-phase", "open");
  await Promise.resolve();
  expect(observation.read()).toEqual(facts);
});
