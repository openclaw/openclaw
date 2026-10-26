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
  const root = mountSolid(
    () => (
      <ApplicationProvider host={container} value={context}>
        {ui()}
      </ApplicationProvider>
    ),
    { container },
  );
  flush();
  return { ...root, widget: () => container.querySelector("openclaw-canvas-widget-view") };
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

it("updates a mounted widget and replaces it when its session or document changes", () => {
  const [current, setCurrent] = createSignal(properties);
  const root = mountCanvas(() => <CanvasWidgetMount {...current()} />);
  const element = root.widget();
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
  expect(root.widget()).toBe(element);
  expect(element).toMatchObject(updated);

  const moved = { ...updated, sessionKey: "agent:main:other" };
  for (const changed of [moved, { ...moved, docId: "cv_other" }]) {
    const previous = root.widget();
    setCurrent(changed);
    flush();
    expect(previous?.isConnected).toBe(false);
    expect(root.widget()).not.toBe(previous);
    expect(root.widget()).toMatchObject(changed);
  }
  root.unmount();
  expect(root.widget()).toBeNull();
});

it("remounts across transcript rows when atomic moves are unavailable", () => {
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  const [row, setRow] = createSignal("live-tool-output");
  const root = mountCanvas(() => (
    <Show when={row()} keyed>
      {(_key) => <CanvasWidgetMount {...properties} />}
    </Show>
  ));
  const original = root.widget();
  expect(original?.isConnected).toBe(true);
  setRow("final-reply");
  flush();
  expect(original?.isConnected).toBe(false);
  expect(root.container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  expect(root.widget()).not.toBe(original);
});

it("pauses a retained widget while its transcript is hidden and resumes the same element", () => {
  const [presented, setPresented] = createSignal(true);
  const [current, setCurrent] = createSignal(properties);
  const root = mountCanvas(() => (
    <ContentPresentation value={presented}>
      <CanvasWidgetMount {...current()} />
    </ContentPresentation>
  ));
  const element = root.widget();
  expect(element).toMatchObject({ ...properties, presentationActive: true });

  const updated = { allowScripts: false, connectionGeneration: 2 };
  for (const [active, overrides] of [
    [false, {}],
    [false, updated],
    [true, updated],
  ] as const) {
    setPresented(active);
    setCurrent({ ...properties, ...overrides });
    flush();
    expect(root.widget()).toBe(element);
    expect(element).toMatchObject({ ...overrides, presentationActive: active, isConnected: true });
  }
});
