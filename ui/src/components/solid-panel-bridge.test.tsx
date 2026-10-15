import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { definePanelBridge } from "./solid-panel-bridge.tsx";
import { SolidPanelController, usePanelController } from "./solid-panel-controller.ts";

type Inputs = { value: number };
class CounterPanel extends SolidPanelController {
  value = 0;
  connections = 0;
  connectedInDocument = false;
  disconnections = 0;
  override connectedCallback() {
    this.connections += 1;
    this.connectedInDocument = this.element.isConnected;
  }
  override disconnectedCallback() {
    this.disconnections += 1;
  }
  increment() {
    this.value += 1;
    return this.value;
  }
}

function fixture() {
  const tag = `test-counter-panel-${crypto.randomUUID()}`;
  const controllers: CounterPanel[] = [];
  const Component = definePanelBridge<Inputs, CounterPanel, "increment">(
    tag,
    (host) => {
      const controller = new CounterPanel(host);
      controllers.push(controller);
      return controller;
    },
    (controller) => {
      usePanelController(controller);
      return <output>{controller.read().value}</output>;
    },
    { properties: { value: { default: 0, type: Number } }, methods: ["increment"] },
  );
  return { tag, Component, controllers };
}

it("shares synchronous inputs with the controller and commits imperative changes", async () => {
  const { tag, controllers } = fixture();
  const element = document.createElement(tag) as HTMLElement &
    Inputs & {
      increment(): number;
      readonly updateComplete: Promise<boolean>;
    };
  element.value = 4;
  document.body.append(element);
  try {
    await element.updateComplete;
    expect(element.textContent).toBe("4");
    expect(element.increment()).toBe(5);
    expect(element.value).toBe(5);
    await element.updateComplete;
    expect(element.textContent).toBe("5");
    expect(controllers[0]?.connections).toBe(1);
    expect(controllers[0]?.connectedInDocument).toBe(true);
  } finally {
    element.remove();
    await Promise.resolve();
  }
  expect(controllers[0]?.disconnections).toBe(1);
});

it("connects a Solid-owned host and reacts to its caller's new inputs", async () => {
  const { Component, controllers } = fixture();
  const [value, setValue] = createSignal(2);
  const view = mountSolid(() => <Component value={value()} />);
  try {
    await waitForSolid(() => expect(view.container.textContent).toBe("2"));
    setValue(9);
    flush();
    await waitForSolid(() => expect(view.container.textContent).toBe("9"));
    expect(controllers[0]?.value).toBe(9);
    expect(controllers[0]?.connections).toBe(1);
    expect(controllers[0]?.connectedInDocument).toBe(true);
  } finally {
    view.unmount();
  }
  expect(controllers[0]?.disconnections).toBe(1);
});
