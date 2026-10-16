/* @vitest-environment jsdom */
import { createSignal, Show } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { CanvasWidgetMount } from "./canvas-widget-mount.tsx";

const properties = {
  docId: "cv_counter",
  sessionKey: "agent:main:dashboard:counter",
  messageTimestamp: 1_000,
  title: "Counter",
  preferredHeight: 240,
  allowScripts: true,
  connectionGeneration: 1,
};

afterEach(cleanupSolid);

it("updates a mounted widget and replaces it when its session or document changes", () => {
  const [current, setCurrent] = createSignal(properties);
  const root = mountSolid(() => <CanvasWidgetMount {...current()} />);
  flush();
  const host = root.container;
  const element = host.querySelector("openclaw-canvas-widget-view");
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
  expect(host.querySelector("openclaw-canvas-widget-view")).toBe(element);
  expect(element).toMatchObject(updated);

  for (const changed of [
    { ...updated, sessionKey: "agent:main:other" },
    { ...updated, docId: "cv_other" },
  ]) {
    const previous = host.querySelector("openclaw-canvas-widget-view");
    setCurrent(changed);
    flush();
    expect(previous?.isConnected).toBe(false);
    expect(host.querySelector("openclaw-canvas-widget-view")).not.toBe(previous);
    expect(host.querySelector("openclaw-canvas-widget-view")).toMatchObject(changed);
  }
  root.unmount();
  expect(host.querySelector("openclaw-canvas-widget-view")).toBeNull();
});

it("remounts across transcript rows when atomic moves are unavailable", () => {
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  const [row, setRow] = createSignal("live-tool-output");
  const root = mountSolid(() => (
    <Show when={row()} keyed>
      {(_key) => (
        <section>
          <CanvasWidgetMount {...properties} />
        </section>
      )}
    </Show>
  ));
  flush();
  const original = root.container.querySelector("openclaw-canvas-widget-view");
  expect(original?.isConnected).toBe(true);
  setRow("final-reply");
  flush();
  expect(original?.isConnected).toBe(false);
  expect(root.container.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  expect(root.container.querySelector("openclaw-canvas-widget-view")).not.toBe(original);
});

it("pauses a retained widget while its transcript is hidden and resumes the same element", () => {
  const [presented, setPresented] = createSignal(true);
  const [current, setCurrent] = createSignal(properties);
  const root = mountSolid(() => (
    <ContentPresentation value={presented}>
      <CanvasWidgetMount {...current()} />
    </ContentPresentation>
  ));
  flush();
  const element = root.container.querySelector("openclaw-canvas-widget-view");
  expect(element).toMatchObject({ ...properties, presentationActive: true });

  setPresented(false);
  flush();
  expect(root.container.querySelector("openclaw-canvas-widget-view")).toBe(element);
  expect(element?.isConnected).toBe(true);
  expect(element).toMatchObject({ presentationActive: false });

  setCurrent({ ...properties, allowScripts: false, connectionGeneration: 2 });
  flush();
  expect(element).toMatchObject({
    allowScripts: false,
    connectionGeneration: 2,
    presentationActive: false,
  });

  setPresented(true);
  flush();
  expect(root.container.querySelector("openclaw-canvas-widget-view")).toBe(element);
  expect(element).toMatchObject({ presentationActive: true, allowScripts: false });
});
