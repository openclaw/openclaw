/* @vitest-environment jsdom */
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

it("retains a widget through updates and hiding, but replaces changed identities without atomic moves", () => {
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const { gateway } = createApplicationGateway();
  const context = createContext(gateway, createTestSessionCapability(gateway));
  onTestFinished(disposeSidebarContextLifecycles);
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  const [row, setRow] = createSignal("live-tool-output");
  const [presented, setPresented] = createSignal(true);
  const [current, setCurrent] = createSignal(properties);
  const root = mountSolid(
    () => (
      <ApplicationProvider host={container} value={context}>
        <ContentPresentation value={presented}>
          <Show when={row()} keyed>
            {() => <CanvasWidgetMount {...current()} />}
          </Show>
        </ContentPresentation>
      </ApplicationProvider>
    ),
    { container },
  );
  flush();
  const widget = () => container.querySelector("openclaw-canvas-widget-view");
  const element = widget();
  expect(element).toMatchObject({ ...properties, presentationActive: true });

  const updated = {
    ...properties,
    title: "Updated counter",
    allowScripts: false,
    connectionGeneration: 2,
  };
  setCurrent(updated);
  flush();
  expect(widget()).toBe(element);
  expect(element).toMatchObject(updated);

  for (const [active, overrides] of [
    [false, {}],
    [false, updated],
    [true, updated],
  ] as const) {
    setPresented(active);
    setCurrent({ ...properties, ...overrides });
    flush();
    expect(widget()).toBe(element);
    expect(element).toMatchObject({ ...overrides, presentationActive: active, isConnected: true });
  }

  const moved = { ...updated, sessionKey: "agent:main:other" };
  for (const changed of [moved, { ...moved, docId: "cv_other" }]) {
    const previous = widget();
    setCurrent(changed);
    flush();
    expect(previous?.isConnected).toBe(false);
    expect(widget()).not.toBe(previous);
    expect(widget()).toMatchObject(changed);
  }
  const original = widget();
  setRow("final-reply");
  flush();
  expect(original?.isConnected).toBe(false);
  expect(root.container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  expect(widget()).not.toBe(original);
  root.unmount();
  expect(widget()).toBeNull();
});

const properties = {
  docId: "cv_counter",
  sessionKey: "agent:main:dashboard:counter",
  title: "Counter",
  allowScripts: true,
  connectionGeneration: 1,
};
