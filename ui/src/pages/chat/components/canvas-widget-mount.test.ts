/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { afterEach, expect, it } from "vitest";
import { canvasWidgetMount } from "./canvas-widget-mount.ts";

const properties = {
  docId: "cv_counter",
  sessionKey: "agent:main:dashboard:counter",
  messageTimestamp: 1_000,
  title: "Counter",
  preferredHeight: 240,
  allowScripts: true,
  connectionGeneration: 1,
};
const hosts: HTMLElement[] = [];

function mountHost() {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    render(nothing, host);
    host.remove();
  }
});

it("updates a mounted widget and replaces it when its session or document changes", () => {
  const host = mountHost();
  render(canvasWidgetMount(properties), host);
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
  render(canvasWidgetMount(updated), host);
  expect(host.querySelector("openclaw-canvas-widget-view")).toBe(element);
  expect(element).toMatchObject(updated);

  for (const changed of [
    { ...updated, sessionKey: "agent:main:other" },
    { ...updated, docId: "cv_other" },
  ]) {
    const previous = host.querySelector("openclaw-canvas-widget-view");
    render(canvasWidgetMount(changed), host);
    expect(previous?.isConnected).toBe(false);
    expect(host.querySelector("openclaw-canvas-widget-view")).not.toBe(previous);
    expect(host.querySelector("openclaw-canvas-widget-view")).toMatchObject(changed);
  }
  render(nothing, host);
  expect(host.querySelector("openclaw-canvas-widget-view")).toBeNull();
});

it("remounts across transcript rows when atomic moves are unavailable", () => {
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  const host = mountHost();
  const row = (key: string) =>
    repeat(
      [key],
      (id) => id,
      () => html`<section>${canvasWidgetMount(properties)}</section>`,
    );
  render(row("live-tool-output"), host);
  const original = host.querySelector("openclaw-canvas-widget-view");
  expect(original?.isConnected).toBe(true);
  render(row("final-reply"), host);
  expect(original?.isConnected).toBe(false);
  expect(host.querySelectorAll("openclaw-canvas-widget-view")).toHaveLength(1);
  expect(host.querySelector("openclaw-canvas-widget-view")).not.toBe(original);
});
