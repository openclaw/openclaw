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
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { ShellLayoutOwner } from "../app/shell-layout-owner.ts";
import { ShellLayoutBoundary } from "../app/shell-layout-traits-solid.tsx";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { collectGarbageForTest } from "../test-helpers/garbage-collection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { ApplicationProvider, useApplication } from "./reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "./solid-bridge.ts";

type Props = { label: string; enabled: boolean; count: number; payload: object | null };
type Methods = { show(): void; close(): void; setPayload(value: object): object };
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
  return new Bridge.Element();
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
  connected.mockClear();
  disconnected.mockClear();
  changed.mockReset();
});
afterEach(async () => {
  cleanup();
  document.body.replaceChildren();
  await Promise.resolve();
});

it("mounts once and preserves setup reads with an application provider", async () => {
  const host = createHost();
  host.setAttribute("label", "attribute");
  host.setAttribute("item-count", "4");
  host.show();
  const payload = {};
  expect(host.setPayload(payload)).toBe(payload);
  expect(host.enabled).toBe(true);
  // SAFETY: this bridge test transports context without reading any capabilities.
  const container = createApplicationContextProvider({} as ApplicationContext);
  container.append(host);
  document.body.append(container);
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
  expect(host.querySelector("section")?.getAttribute("data-owned")).toBe("attribute");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("publishes changed properties synchronously before rendering and suppresses equal assignments", async () => {
  const host = createHost();
  document.body.append(host);
  await host.updateComplete;
  const observations: string[] = [];
  changed.mockImplementation((current, key) => {
    observations.push(`${key}:${current.label}:${current.querySelector("output")?.textContent}`);
  });
  host.label = "next";
  expect(observations).toEqual(["label:next:initial:0:false"]);
  expect(changed).toHaveBeenCalledWith(host, "label");
  host.label = "next";
  expect(changed).toHaveBeenCalledTimes(1);
  await host.updateComplete;
  expect(host.querySelector("output")?.textContent).toBe("next:0:false");
  changed.mockReset();
});

it("batches property bursts without invalidating unrelated Solid computations", async () => {
  const labels = vi.fn((value: string) => value);
  const counts = vi.fn((value: number) => value);
  const mount = vi.fn();
  let readLabel = () => "";
  defineSolidBridge<{ label: string; count: number }>(
    "openclaw-solid-granular-test",
    (props) => {
      mount();
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
  const host = document.createElement("openclaw-solid-granular-test") as SolidBridgeElement<{
    label: string;
    count: number;
  }>;
  document.body.append(host);
  await host.updateComplete;
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
  expect(mount).toHaveBeenCalledTimes(1);
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
  const left = document.createElement("div");
  const right = document.createElement("div");
  document.body.append(left, right);
  const host = createHost();
  left.append(host);
  expect(connected).toHaveBeenCalledExactlyOnceWith(host);
  await host.updateComplete;
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

it("keeps a tooltip's named caller slots live through DOM updates and reconnect", async () => {
  await import("../components/tooltip.ts");
  const container = document.createElement("div");
  document.body.append(container);
  const host = document.createElement("openclaw-tooltip");
  host.setAttribute("content", "Details");
  const trigger = document.createElement("button");
  const content = document.createElement("div");
  content.slot = "content";
  const update = (label: string) => {
    trigger.textContent = label;
    content.textContent = `Rich ${label}`;
  };
  update("first");
  host.append(trigger, content);
  container.append(host);
  await host.updateComplete;
  const assigned = () =>
    host.shadowRoot!.querySelector<HTMLSlotElement>('slot[name="content"]')!.assignedElements();
  expect(assigned()).toEqual([content]);
  update("next");
  await host.updateComplete;
  expect(host.querySelector("button")).toBe(trigger);
  expect(trigger.textContent).toBe("next");
  expect(content.textContent).toBe("Rich next");
  host.remove();
  await Promise.resolve();
  container.append(host);
  await host.updateComplete;
  expect(host.querySelector("button")).toBe(trigger);
  expect(assigned()).toEqual([content]);
  update("last");
  await host.updateComplete;
  expect(trigger.textContent).toBe("last");
  expect(content.textContent).toBe("Rich last");
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
  expect(disconnected).toHaveBeenCalledExactlyOnceWith(host);
  await Promise.resolve();
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("accepts property publication while a Solid owner adopts a mounted bridge", async () => {
  const host = createHost();
  document.body.append(host);
  await host.updateComplete;
  const view = render(() => {
    host.label = "adopted";
    return <div>{host}</div>;
  });
  await host.updateComplete;
  expect(view.container.querySelector("output")?.textContent).toBe("adopted:0:false");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it.each(["attribute"])("honors the public setter when updating %s", async (input) => {
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
});

it("provides the Solid application context, rebinds replacements, and unsubscribes", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  onTestFinished(() => warning.mockRestore());
  const seen = vi.fn();
  const connection = vi.fn();
  const ContextBridge = defineSolidBridge(
    "openclaw-solid-context-test",
    () => {
      const application = useApplication();
      seen(application);
      return <output>{application.basePath}</output>;
    },
    { properties: {}, connected: connection },
  );
  const first = { basePath: "/first" } as ApplicationContext;
  const second = { basePath: "/second" } as ApplicationContext;
  const container = createApplicationContextProvider(first);
  document.body.append(container);
  const host = document.createElement("openclaw-solid-context-test") as SolidBridgeElement<object>;
  render(() => {
    createEffect(
      () => host,
      (element) => container.append(element),
    );
    return null;
  });
  await host.updateComplete;
  expect(seen).toHaveBeenLastCalledWith(first);
  expect(warning).not.toHaveBeenCalled();
  container.setContext(second);
  await host.updateComplete;
  expect(host.textContent).toBe("/second");
  expect(seen).toHaveBeenLastCalledWith(second);
  container.setContext(first);
  await host.updateComplete;
  expect(host.textContent).toBe("/first");
  expect(connection).toHaveBeenCalledExactlyOnceWith(host);
  host.remove();
  await Promise.resolve();
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
  const outer = createApplicationContextProvider(first);
  const inner = document.createElement("div");
  outer.append(inner);
  document.body.append(outer);
  const host = document.createElement(
    "openclaw-solid-provider-handoff-test",
  ) as SolidBridgeElement<object>;
  inner.append(host);
  await host.updateComplete;
  const innerProvider = render(() => <ApplicationProvider value={first} host={inner} />);
  await host.updateComplete;
  seen.mockClear();
  outer.setContext(second);
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
  expect(host.textContent).toBe("/first");
  host.remove();
  await Promise.resolve();
  outer.setContext(first);
  innerProvider.unmount();
  await host.updateComplete;
  expect(seen).not.toHaveBeenCalled();
});

it("publishes an imperatively mounted page's layout traits to the existing shell owner", async () => {
  defineSolidBridge(
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
  const host = document.createElement("openclaw-solid-native-layout-test") as SolidBridgeElement<{
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
