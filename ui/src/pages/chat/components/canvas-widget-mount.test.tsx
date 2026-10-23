/* @vitest-environment jsdom */
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { CanvasWidgetMount } from "./canvas-widget-mount.tsx";

function mountCanvas(ui: () => JSX.Element) {
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const { gateway } = createApplicationGateway();
  const sessions = createTestSessionCapability(gateway);
  const context = createContext(gateway, sessions);
  onTestFinished(disposeSidebarContextLifecycles);
  return mountSolid(
    () => (
      <ApplicationProvider host={container} value={context}>
        {ui()}
      </ApplicationProvider>
    ),
    { container },
  );
}

const properties = {
  docId: "cv_counter",
  sessionKey: "agent:main:dashboard:counter",
  messageTimestamp: 1_000,
  title: "Counter",
  preferredHeight: 240,
  allowScripts: true,
  connectionGeneration: 1,
};

const widget = (host: ParentNode) => host.querySelector("openclaw-canvas-widget-view");

it("updates a mounted widget and replaces it when its session or document changes", () => {
  const [current, setCurrent] = createSignal(properties);
  const root = mountCanvas(() => <CanvasWidgetMount {...current()} />);
  flush();
  const host = root.container;
  const element = widget(host);
  expect(element).toMatchObject(properties);

  const updated = {
    ...properties,
    messageTimestamp: 2_000,
    title: "Updated counter",
    preferredHeight: 320,
    allowScripts: false,
    connectionGeneration: 2,
  };
  setCurrent(updated);
  flush();
  expect(widget(host)).toBe(element);
  expect(element).toMatchObject(updated);

  for (const changed of [
    { ...updated, sessionKey: "agent:main:other" },
    { ...updated, docId: "cv_other" },
  ]) {
    const previous = widget(host);
    setCurrent(changed);
    flush();
    expect(previous?.isConnected).toBe(false);
    expect(widget(host)).not.toBe(previous);
    expect(widget(host)).toMatchObject(changed);
  }
  root.unmount();
  expect(widget(host)).toBeNull();
});

it("remounts across transcript rows when atomic moves are unavailable", () => {
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  const [row, setRow] = createSignal("live-tool-output");
  const root = mountCanvas(() => (
    <Show when={row()} keyed>
      {(_key) => <CanvasWidgetMount {...properties} />}
    </Show>
  ));
  flush();
  const original = widget(root.container);
  expect(original?.isConnected).toBe(true);
  setRow("final-reply");
  flush();
  expect(original?.isConnected).toBe(false);
  expect(root.container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  expect(widget(root.container)).not.toBe(original);
});

it("pauses a retained widget while its transcript is hidden and resumes the same element", () => {
  const [presented, setPresented] = createSignal(true);
  const [current, setCurrent] = createSignal(properties);
  const root = mountCanvas(() => (
    <ContentPresentation value={presented}>
      <CanvasWidgetMount {...current()} />
    </ContentPresentation>
  ));
  flush();
  const element = widget(root.container);
  expect(element).toMatchObject({ ...properties, presentationActive: true });

  const updated = { allowScripts: false, connectionGeneration: 2 };
  const phases = [
    [false, {}],
    [false, updated],
    [true, updated],
  ] as const;
  for (const [active, overrides] of phases) {
    setPresented(active);
    setCurrent({ ...properties, ...overrides });
    flush();
    expect(widget(root.container)).toBe(element);
    expect(element).toMatchObject({ ...overrides, presentationActive: active, isConnected: true });
  }
});
