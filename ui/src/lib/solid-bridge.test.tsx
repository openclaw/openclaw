import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import {
  createEffect,
  createMemo,
  createReaction,
  createRoot,
  createSignal,
  flush,
  onCleanup,
} from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { ShellLayoutOwner } from "../app/shell-layout-owner.ts";
import { ShellLayoutBoundary } from "../app/shell-layout-traits-solid.tsx";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { collectGarbageForTest } from "../test-helpers/garbage-collection.ts";
import { ApplicationProvider, useApplication } from "./reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "./solid-bridge.ts";

type Props = { label: string; enabled: boolean; count: number; payload: object | null };
type Methods = { setPayload(value: object): object };
type Host = SolidBridgeElement<Props, Methods>;
const mounted = vi.fn<(value: object) => void>();
const disposed = vi.fn();
const connected = vi.fn();
const disconnected = vi.fn();
const changed = vi.fn<(host: Host, key: keyof Props) => void>();
const Bridge = defineSolidBridge<Props, Methods>(
  "openclaw-solid-bridge-test",
  (props, host) => {
    const local = { id: props.label };
    mounted(local);
    onCleanup(() => disposed(local));
    const act = () =>
      host.dispatchEvent(new CustomEvent("bridge-action", { detail: props.payload }));
    return (
      <section data-owned={local.id}>
        <output>{`${props.label}:${props.count}:${props.enabled}`}</output>
        <button onClick={act}>Action</button>
        <div class="caller-content">{props.children}</div>
      </section>
    );
  },
  {
    connected,
    disconnected,
    properties: {
      label: { default: "initial" },
      enabled: { default: false, type: Boolean, reflect: true },
      count: { default: 0, type: Number, attribute: "item-count" },
      payload: { default: null, attribute: false },
    },
    propertyChanged: changed,
    methods: {
      setPayload: (host, value) => {
        host.payload = value;
        return value;
      },
    },
  },
);

async function mountHost<T extends SolidBridgeElement<object>>(host: T, parent = document.body) {
  parent.append(host);
  await host.updateComplete;
  return host;
}

async function expectOutput(host: SolidBridgeElement<object>, text: string) {
  await host.updateComplete;
  expect(host.querySelector("output")?.textContent).toBe(text);
}

function disconnect(host: HTMLElement) {
  host.remove();
  return Promise.resolve();
}

function contextBridge(tag: string, textOnly = false) {
  const seen = vi.fn();
  const connection = vi.fn();
  const first = { basePath: "/first" } as ApplicationContext;
  const second = { basePath: "/second" } as ApplicationContext;
  const container = createApplicationContextProvider(first);
  const ContextBridge = defineSolidBridge(
    tag,
    () => {
      const application = useApplication();
      seen(application);
      return textOnly ? application.basePath : <output>{application.basePath}</output>;
    },
    { properties: {}, connected: connection },
  );
  return { seen, connection, first, second, container, ContextBridge };
}

it("runs Solid caller effects after the parent render completes", () => {
  const EffectBridge = defineSolidBridge<{ label: string }>(
    "openclaw-solid-effect-bridge-test",
    (props) => {
      const [label, setLabel] = createSignal("");
      createEffect(
        () => props.label,
        (value) => void setLabel(value),
      );
      return <output>{label()}</output>;
    },
    { properties: { label: { default: "" } } },
  );
  const view = render(() => <EffectBridge label="committed" />);
  expect(view.getByText("committed")).toBeTruthy();
});

beforeEach(() => {
  vi.clearAllMocks();
  changed.mockReset();
});
afterEach(async () => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await Promise.resolve();
});

it("mounts once and preserves setup reads with an application provider", async () => {
  const host = new Bridge.Element();
  host.setAttribute("label", "attribute");
  host.setAttribute("item-count", "4");
  host.enabled = true;
  const payload = {};
  expect(host.setPayload(payload)).toBe(payload);
  // SAFETY: this bridge test transports context without reading any capabilities.
  const container = createApplicationContextProvider({} as ApplicationContext);
  container.append(host);
  document.body.append(container);
  await expectOutput(host, "attribute:4:true");
  expect(host.payload).toBe(payload);
  expect(host.hasAttribute("payload")).toBe(false);

  host.label = "property";
  host.removeAttribute("enabled");
  await expectOutput(host, "property:4:false");
  expect(host.querySelector("section")?.getAttribute("data-owned")).toBe("attribute");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("publishes changed properties synchronously before rendering and suppresses equal assignments", async () => {
  const host = await mountHost(new Bridge.Element());
  const observations: string[] = [];
  changed.mockImplementation((current, key) => {
    observations.push(`${key}:${current.label}:${current.querySelector("output")?.textContent}`);
  });
  host.label = "next";
  expect(observations).toEqual(["label:next:initial:0:false"]);
  host.label = "next";
  expect(observations).toHaveLength(1);
  await expectOutput(host, "next:0:false");
});

it("preserves enumerable declared props and their children value", async () => {
  const DeclaredChildren = defineSolidBridge<{ label: string; children: string; count: number }>(
    "openclaw-solid-declared-children-test",
    (props) => (
      <output>
        {Object.entries(props)
          .map(([key, value]) => `${key}=${value}`)
          .join(",")}
      </output>
    ),
    {
      properties: {
        label: { default: "initial" },
        children: { default: "declared", attribute: false },
        count: { default: 0 },
      },
    },
  );
  const host = await mountHost(new DeclaredChildren.Element());
  await expectOutput(host, "label=initial,children=declared,count=0");
  host.label = "updated";
  await expectOutput(host, "label=updated,children=declared,count=0");
});

it("batches property bursts without invalidating unrelated Solid computations", async () => {
  const labels = vi.fn((value: string) => value);
  const counts = vi.fn((value: number) => value);
  let readLabel = () => "";
  const GranularBridge = defineSolidBridge<{ label: string; count: number }>(
    "openclaw-solid-granular-test",
    (props) => {
      // Sample the live prop in a tracked scope without flushing the pending render.
      readLabel = () =>
        createRoot((dispose) => {
          let value = "";
          const track = createReaction(() => undefined);
          track(() => {
            value = props.label;
          });
          dispose();
          return value;
        });
      const label = createMemo(() => labels(props.label));
      const count = createMemo(() => counts(props.count));
      return (
        <output>
          {label()}:{count()}
          <input />
        </output>
      );
    },
    { properties: { label: { default: "initial" }, count: { default: 0 } } },
  );
  const host = await mountHost(new GranularBridge.Element());
  const input = host.querySelector("input")!;
  input.value = "draft";
  labels.mockClear();
  counts.mockClear();

  host.label = "intermediate";
  host.label = "final";
  expect(host.label).toBe("final");
  expect(readLabel()).toBe("final");
  await host.updateComplete;
  expect(host.textContent).toBe("final:0");
  expect(labels).toHaveBeenCalledExactlyOnceWith("final");
  expect(counts).not.toHaveBeenCalled();
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("draft");

  labels.mockClear();
  host.count = 2;
  await host.updateComplete;
  expect(host.textContent).toBe("final:2");
  expect(labels).not.toHaveBeenCalled();
  expect(counts).toHaveBeenCalledExactlyOnceWith(2);
});

it("keeps the same root across moves and releases/recreates it after a real disconnect", async () => {
  const right = document.createElement("div");
  document.body.append(right);
  const host = await mountHost(new Bridge.Element());
  expect(connected).toHaveBeenCalledExactlyOnceWith(host);
  const section = host.querySelector("section");
  right.append(host);
  expect(disconnected).toHaveBeenCalledExactlyOnceWith(host);
  expect(connected).toHaveBeenCalledTimes(2);
  await host.updateComplete;
  expect(host.querySelector("section")).toBe(section);
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(disposed).not.toHaveBeenCalled();

  host.remove();
  expect(disconnected).toHaveBeenCalledTimes(2);
  expect(disposed).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(host.childNodes).toHaveLength(0);
  host.label = "reconnected";
  right.append(host);
  await expectOutput(host, "reconnected:0:false");
  expect(mounted).toHaveBeenCalledTimes(2);
});

it("preserves caller content through updates and reconnects", async () => {
  const host = new Bridge.Element();
  const input = document.createElement("input");
  host.append(input);
  await mountHost(host);
  input.value = "next";
  const second = document.createElement("input");
  input.parentElement!.append(second);

  await disconnect(host);
  await mountHost(host);
  expect([...host.querySelectorAll("input")]).toEqual([input, second]);
  expect(input.value).toBe("next");
  second.remove();
  expect([...host.querySelectorAll("input")]).toEqual([input]);
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
  expect(connected).toHaveBeenCalledExactlyOnceWith(host);
  host!.enabled = true;
  const payload = {};
  host!.setPayload(payload);
  setLabel("updated");
  flush();
  expect(host!.querySelector("output")?.textContent).toBe("updated:0:true");
  expect(host!.payload).toBe(payload);
  expect(host!.querySelector("span")?.textContent).toBe("updated");
  fireEvent.click(view.getByRole("button"));
  expect(action).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(disconnected).toHaveBeenCalledExactlyOnceWith(host);
  await Promise.resolve();
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("accepts property publication while a Solid owner adopts a mounted bridge", async () => {
  const host = await mountHost(new Bridge.Element());
  const view = render(() => {
    host.label = "adopted";
    return <div>{host}</div>;
  });
  await host.updateComplete;
  expect(view.container.querySelector("output")?.textContent).toBe("adopted:0:false");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("honors the public setter when updating an attribute", async () => {
  const SetterBridge = defineSolidBridge<{ label: string }>(
    `openclaw-solid-setter-${crypto.randomUUID()}`,
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
  const host = await mountHost(new SetterBridge.Element());
  host.setAttribute("label", "normalized");
  expect(host.label).toBe("NORMALIZED");
  await expectOutput(host, "NORMALIZED");
});

it("provides the Solid application context, rebinds replacements, and unsubscribes", async () => {
  const { seen, connection, first, second, container, ContextBridge } = contextBridge(
    "openclaw-solid-context-test",
  );
  document.body.append(container);
  const host = new ContextBridge.Element();
  render(() => {
    createEffect(
      () => host,
      (element) => container.append(element),
    );
    return null;
  });
  await host.updateComplete;
  expect(host.textContent).toBe("/first");
  container.setContext(second);
  await host.updateComplete;
  expect(host.textContent).toBe("/second");
  container.setContext(first);
  await host.updateComplete;
  expect(host.textContent).toBe("/first");
  expect(connection).toHaveBeenCalledExactlyOnceWith(host);
  await disconnect(host);
  seen.mockClear();
  container.setContext(first);
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
  const {
    seen,
    first,
    second,
    container: outer,
    ContextBridge,
  } = contextBridge("openclaw-solid-provider-handoff-test", true);
  const inner = document.createElement("div");
  outer.append(inner);
  document.body.append(outer);
  const host = await mountHost(new ContextBridge.Element(), inner);
  const innerProvider = render(() => <ApplicationProvider value={first} host={inner} />);
  await host.updateComplete;
  seen.mockClear();
  outer.setContext(second);
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
  expect(host.textContent).toBe("/first");
  await disconnect(host);
  outer.setContext(first);
  innerProvider.unmount();
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
});

it("publishes an imperatively mounted page's layout traits to the existing shell owner", async () => {
  const LayoutBridge = defineSolidBridge(
    "openclaw-solid-native-layout-test",
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
  const host = await mountHost(new LayoutBridge.Element(), main);
  expect(main.classList.contains("content--toolbar-header")).toBe(true);
  for (const active of [false, true]) {
    host.active = active;
    await host.updateComplete;
    expect(main.classList.contains("content--toolbar-header")).toBe(active);
  }
  await disconnect(host);
  expect(main.classList.contains("content--toolbar-header")).toBe(false);
});

it("releases a disconnected Solid root while the custom element itself is retained", async () => {
  const host = await mountHost(new Bridge.Element());
  expect(mounted).toHaveBeenCalledTimes(1);
  const weak = new WeakRef(mounted.mock.calls[0]![0]);
  const control = new WeakRef({ control: true });
  mounted.mockClear();
  await disconnect(host);
  disposed.mockClear();
  await collectGarbageForTest();
  expect(control.deref()).toBeUndefined();
  expect(weak.deref()).toBeUndefined();
  expect(host.isConnected).toBe(false);
});
