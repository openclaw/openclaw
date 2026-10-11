import { ContextProvider } from "@lit/context";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { LitElement, html } from "lit";
import { createEffect, createSignal, flush, onCleanup } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { ShellLayoutOwner } from "../app/shell-layout-owner.ts";
import { ShellLayoutBoundary, ShellLayoutProvider } from "../app/shell-layout-traits-solid.tsx";
import { ApplicationProvider, useApplication } from "../lib/reactive/context.ts";
import { collectGarbageForTest } from "../test-helpers/garbage-collection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "./solid-bridge.ts";

type Props = { label: string; enabled: boolean; count: number; payload: object | null };
type Methods = { show(): void; close(): void; setPayload(value: object): object };
type Host = SolidBridgeElement<Props, Methods>;
const mounted = vi.fn<(value: object) => void>();
const disposed = vi.fn();
const Bridge = defineSolidBridge<Props, Methods>(
  "openclaw-solid-bridge-test",
  (props, host) => {
    const local = { id: "owned" };
    mounted(local);
    onCleanup(() => disposed(local));
    return (
      <section data-owned={local.id}>
        <output>
          {props.label}:{props.count}:{String(props.enabled)}
        </output>
        <button
          type="button"
          onClick={() =>
            host.dispatchEvent(
              new CustomEvent("bridge-action", {
                detail: props.payload,
                bubbles: true,
                composed: true,
                cancelable: true,
              }),
            )
          }
        >
          Action
        </button>
        <div class="caller-content">{props.children}</div>
      </section>
    );
  },
  {
    properties: {
      label: { default: "initial" },
      enabled: { default: false, type: Boolean, reflect: true },
      count: { default: 0, type: Number, attribute: "item-count" },
      payload: { default: null, attribute: false },
    },
    methods: {
      show: (host) => {
        host.enabled = true;
      },
      close: (host) => {
        host.enabled = false;
      },
      setPayload: (host, value) => {
        host.payload = value;
        return value;
      },
    },
  },
);

function createHost() {
  return document.createElement("openclaw-solid-bridge-test") as Host;
}

it("runs Solid caller effects after the parent render completes", () => {
  const EffectBridge = defineSolidBridge<{ label: string }>(
    "openclaw-solid-effect-bridge-test",
    (props) => {
      const [label, setLabel] = createSignal("");
      createEffect(
        () => props.label,
        (value) => {
          setLabel(value);
        },
      );
      return <output>{label()}</output>;
    },
    { properties: { label: { default: "" } } },
  );
  const view = render(() => <EffectBridge label="committed" />);
  expect(view.getByText("committed")).toBeTruthy();
});

beforeEach(() => {
  mounted.mockClear();
  disposed.mockClear();
});
afterEach(async () => {
  cleanup();
  document.body.replaceChildren();
  await Promise.resolve();
});

it("mounts once, mirrors attributes/properties, and preserves synchronous imperative methods", async () => {
  const host = createHost();
  host.setAttribute("label", "attribute");
  host.setAttribute("item-count", "4");
  host.show();
  const payload = {};
  expect(host.setPayload(payload)).toBe(payload);
  expect(host.enabled).toBe(true);
  document.body.append(host);
  await host.updateComplete;
  expect(host.querySelector("output")?.textContent).toBe("attribute:4:true");
  expect(host.payload).toBe(payload);
  expect(host.hasAttribute("payload")).toBe(false);
  expect(mounted).toHaveBeenCalledTimes(1);

  host.label = "property";
  host.removeAttribute("enabled");
  host.close();
  await host.updateComplete;
  expect(host.querySelector("output")?.textContent).toBe("property:4:false");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("commits Solid DOM before a Lit parent updateComplete resumes", async () => {
  class Parent extends LitElement {
    static override properties = { label: {} };
    label = "first";
    override createRenderRoot() {
      return this;
    }
    override render() {
      return html`<openclaw-solid-bridge-test .label=${this.label}></openclaw-solid-bridge-test>`;
    }
  }
  customElements.define("openclaw-solid-bridge-parent", Parent);
  const parent = new Parent();
  document.body.append(parent);
  await parent.updateComplete;
  expect(parent.querySelector("output")?.textContent).toBe("first:0:false");
  parent.label = "next";
  await parent.updateComplete;
  expect(parent.querySelector("output")?.textContent).toBe("next:0:false");
});

it("keeps the same root across moves and releases/recreates it after a real disconnect", async () => {
  const left = document.createElement("div");
  const right = document.createElement("div");
  document.body.append(left, right);
  const host = createHost();
  left.append(host);
  await host.updateComplete;
  const section = host.querySelector("section");
  right.append(host);
  await host.updateComplete;
  expect(host.querySelector("section")).toBe(section);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(disposed).not.toHaveBeenCalled();

  host.remove();
  await Promise.resolve();
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(host.childNodes).toHaveLength(0);
  host.label = "reconnected";
  right.append(host);
  await host.updateComplete;
  expect(host.querySelector("output")?.textContent).toBe("reconnected:0:false");
  expect(mounted).toHaveBeenCalledTimes(2);
});

it("preserves caller content through updates and reconnects", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const host = createHost();
  const input = document.createElement("input");
  input.value = "first";
  host.append(input);
  container.append(host);
  await host.updateComplete;
  const outlet = input.parentElement!;
  input.value = "next";
  const second = document.createElement("input");
  outlet.append(second);
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("next");
  expect(host.querySelectorAll("input")).toHaveLength(2);

  host.remove();
  await Promise.resolve();
  container.append(host);
  await host.updateComplete;
  expect(host.querySelector("input")).toBe(input);
  expect(host.querySelectorAll("input")).toHaveLength(2);
  input.value = "last";
  second.remove();
  expect(input.value).toBe("last");
  expect(host.querySelectorAll("input")).toHaveLength(1);
});

it("delivers the original bubbling, cancelable event with its exact detail", async () => {
  const host = createHost();
  const payload = {};
  host.payload = payload;
  document.body.append(host);
  await host.updateComplete;
  let received: Event | undefined;
  document.body.addEventListener(
    "bridge-action",
    (event) => {
      received = event;
      event.preventDefault();
    },
    { once: true },
  );
  fireEvent.click(host.querySelector("button")!);
  expect(received).toBeInstanceOf(CustomEvent);
  expect((received as CustomEvent).detail).toBe(payload);
  expect(received?.target).toBe(host);
  expect(received?.composed).toBe(true);
  expect(received?.defaultPrevented).toBe(true);
});

it("uses a single Solid-owned host and preserves reactive props, children, events, and disposal", async () => {
  const [label, setLabel] = createSignal("solid");
  const action = vi.fn();
  let host: Host | undefined;
  const view = render(() => (
    <Bridge
      label={label()}
      ref={(element) => {
        host = element;
      }}
      onBridge-action={action}
      class="direct"
    >
      <span>{label()}</span>
    </Bridge>
  ));
  expect(view.container.querySelectorAll("openclaw-solid-bridge-test")).toHaveLength(1);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(host?.className).toBe("direct");
  host?.show();
  const payload = {};
  host?.setPayload(payload);
  setLabel("updated");
  flush();
  expect(host?.querySelector("output")?.textContent).toBe("updated:0:true");
  expect(host?.payload).toBe(payload);
  expect(host?.querySelector("span")?.textContent).toBe("updated");
  fireEvent.click(view.getByRole("button"));
  expect(action).toHaveBeenCalledTimes(1);
  view.unmount();
  await Promise.resolve();
  expect(disposed).toHaveBeenCalledTimes(1);
});

it.each(["attribute", "Solid props"])(
  "honors the public setter when updating %s",
  async (input) => {
    const tag = `openclaw-solid-setter-${crypto.randomUUID()}`;
    const SetterBridge = defineSolidBridge<{ label: string }>(
      tag,
      (props, host) => {
        const property = Object.getOwnPropertyDescriptor(host, "label")!;
        Object.defineProperty(host, "label", {
          ...property,
          set(value: string) {
            property.set!.call(host, value.toUpperCase());
          },
        });
        onCleanup(() => Object.defineProperty(host, "label", property));
        return <output>{props.label}</output>;
      },
      { properties: { label: { default: "initial" } } },
    );
    const [label, setLabel] = createSignal("initial");
    const view = mountSolid(() =>
      input === "attribute" ? document.createElement(tag) : <SetterBridge label={label()} />,
    );
    const host = view.container.querySelector(tag) as SolidBridgeElement<{ label: string }>;
    await host.updateComplete;

    if (input === "attribute") {
      host.setAttribute("label", "normalized");
    } else {
      setLabel("normalized");
      flush();
    }
    expect(host.label).toBe("NORMALIZED");
    await host.updateComplete;
    expect(host.querySelector("output")?.textContent).toBe("NORMALIZED");
  },
);

it("provides the existing Lit application context, rebinds replacements, and unsubscribes", async () => {
  const seen = vi.fn();
  const ContextBridge = defineSolidBridge(
    "openclaw-solid-context-test",
    () => {
      const application = useApplication();
      seen(application);
      return <output>{application.basePath}</output>;
    },
    { properties: {} },
  );
  const first = { basePath: "/first" } as ApplicationContext;
  const second = { basePath: "/second" } as ApplicationContext;
  const container = document.createElement("div");
  const provider = new ContextProvider(container, {
    context: applicationContext,
    initialValue: first,
  });
  document.body.append(container);
  const host = document.createElement("openclaw-solid-context-test") as SolidBridgeElement<object>;
  container.append(host);
  await host.updateComplete;
  expect(seen).toHaveBeenLastCalledWith(first);
  provider.setValue(second);
  await host.updateComplete;
  expect(host.textContent).toBe("/second");
  expect(seen).toHaveBeenLastCalledWith(second);
  host.remove();
  await Promise.resolve();
  seen.mockClear();
  provider.setValue(first);
  await Promise.resolve();
  expect(seen).not.toHaveBeenCalled();

  const view = render(() => (
    <ApplicationProvider value={first}>
      <ContextBridge />
    </ApplicationProvider>
  ));
  expect(view.container.textContent).toBe("/first");
  view.unmount();
});

it("releases the old provider when a nearer provider takes over without moving the host", async () => {
  const seen = vi.fn();
  defineSolidBridge(
    "openclaw-solid-provider-handoff-test",
    () => {
      const application = useApplication();
      seen(application);
      return application.basePath;
    },
    { properties: {} },
  );
  const first = { basePath: "/first" } as ApplicationContext;
  const second = { basePath: "/second" } as ApplicationContext;
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  const outerProvider = new ContextProvider(outer, {
    context: applicationContext,
    initialValue: first,
  });
  outer.append(inner);
  document.body.append(outer);
  const host = document.createElement(
    "openclaw-solid-provider-handoff-test",
  ) as SolidBridgeElement<object>;
  inner.append(host);
  await host.updateComplete;
  const innerProvider = new ContextProvider(inner, {
    context: applicationContext,
    initialValue: first,
  });
  innerProvider.hostConnected();
  await host.updateComplete;
  seen.mockClear();
  outerProvider.setValue(second);
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
  expect(host.textContent).toBe("/first");
  host.remove();
  await Promise.resolve();
  outerProvider.setValue(first);
  innerProvider.setValue(second);
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
});

it("publishes a Lit-hosted page's layout traits to the existing shell owner", async () => {
  defineSolidBridge(
    "openclaw-solid-lit-layout-test",
    (props: { active: boolean }) => (
      <ShellLayoutBoundary traits={{ toolbarHeader: props.active }}>
        <h1>Page header</h1>
      </ShellLayoutBoundary>
    ),
    { properties: { active: { default: true, attribute: false } } },
  );
  const main = document.createElement("main");
  main.className = "content";
  document.body.append(main);
  const owner = new ShellLayoutOwner();
  owner.contentRef(main);
  const host = document.createElement("openclaw-solid-lit-layout-test") as SolidBridgeElement<{
    active: boolean;
  }>;
  main.append(host);
  await host.updateComplete;
  expect(main.classList.contains("content--toolbar-header")).toBe(true);
  host.active = false;
  await host.updateComplete;
  expect(main.classList.contains("content--toolbar-header")).toBe(false);
  host.active = true;
  await host.updateComplete;
  expect(main.classList.contains("content--toolbar-header")).toBe(true);
  host.remove();
  await Promise.resolve();
  expect(main.classList.contains("content--toolbar-header")).toBe(false);
});

it("preserves the inherited layout scope of a Solid-owned page", () => {
  const LayoutBridge = defineSolidBridge(
    "openclaw-solid-owned-layout-test",
    () => (
      <ShellLayoutBoundary traits={{ settingsPage: true }}>
        <h1>Settings</h1>
      </ShellLayoutBoundary>
    ),
    { properties: {} },
  );
  const main = document.createElement("main");
  main.className = "content";
  const route = document.createElement("div");
  main.append(route);
  document.body.append(main);
  const owner = new ShellLayoutOwner();
  owner.contentRef(main);
  const view = mountSolid(
    () => (
      <ShellLayoutProvider value={{ owner, host: route }}>
        <LayoutBridge />
      </ShellLayoutProvider>
    ),
    { container: route },
  );
  expect(main.classList.contains("content--settings-page")).toBe(true);
  view.unmount();
  expect(main.classList.contains("content--settings-page")).toBe(false);
});

it("releases a disconnected Solid root while the custom element itself is retained", async () => {
  const host = createHost();
  document.body.append(host);
  await host.updateComplete;
  expect(mounted).toHaveBeenCalledTimes(1);
  const weak = new WeakRef(mounted.mock.calls[0]![0]);
  const control = new WeakRef({ control: true });
  mounted.mockClear();
  host.remove();
  await Promise.resolve();
  disposed.mockClear();
  await collectGarbageForTest();
  expect(control.deref()).toBeUndefined();
  expect(weak.deref()).toBeUndefined();
  expect(host.isConnected).toBe(false);
});
