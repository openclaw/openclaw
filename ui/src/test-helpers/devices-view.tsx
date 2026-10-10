import { createSignal, flush } from "solid-js";
import { afterEach, expect } from "vitest";
import { DevicesView } from "../pages/devices/view.tsx";
import type { DevicesProps } from "../pages/devices/view.types.ts";
import { createDevicesViewProps } from "./devices-fixtures.ts";
import { mountSolid } from "./solid.ts";

const fixtures = new Map<
  HTMLElement,
  { update: (props: DevicesProps) => void; dispose: () => void }
>();
afterEach(() => {
  for (const fixture of fixtures.values()) {
    fixture.dispose();
  }
  fixtures.clear();
});

export function renderDevicesInto(container: HTMLElement, overrides: Partial<DevicesProps>) {
  const props = createDevicesViewProps(overrides);
  const mounted = fixtures.get(container);
  if (mounted) {
    mounted.update(props);
    flush();
    return;
  }
  const view = mountSolid(() => {
    const [current, setCurrent] = createSignal(props);
    fixtures.set(container, { update: (next) => setCurrent(next), dispose: () => {} });
    return <DevicesView {...current()} />;
  }, container);
  const fixture = fixtures.get(container);
  if (fixture) {
    fixture.dispose = view.dispose;
  }
}

export function renderDevicesContainer(overrides: Partial<DevicesProps>): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  renderDevicesInto(container, overrides);
  return container;
}

export function getDevicesSection(container: Element, heading: string): Element {
  const section = Array.from(container.querySelectorAll(".settings-section")).find((candidate) =>
    candidate.querySelector(".settings-section__heading")?.textContent?.trim().startsWith(heading),
  );
  expect(section).toBeInstanceOf(Element);
  if (!(section instanceof Element)) {
    throw new Error(`Expected ${heading} section`);
  }
  return section;
}

export function getDeviceSettingsRow(container: Element, title: string): Element {
  const row = Array.from(container.querySelectorAll(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  expect(row).toBeInstanceOf(Element);
  if (!(row instanceof Element)) {
    throw new Error(`Expected ${title} row`);
  }
  return row;
}
