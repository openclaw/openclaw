import { createSignal, flush } from "solid-js";
import { afterEach, expect } from "vitest";
import { DevicesView } from "../pages/devices/view.tsx";
import type { DevicesProps } from "../pages/devices/view.types.ts";
import { createDevicesViewProps } from "./devices-fixtures.ts";
import { mountSolid } from "./mount-solid.ts";

const fixtures = new Map<HTMLElement, (props: DevicesProps) => void>();
afterEach(() => fixtures.clear());

export function openDeviceDisclosures(container: ParentNode) {
  // Rendering tests inspect body controls; reveal them through the native event contract.
  for (;;) {
    const closed = container.querySelectorAll<HTMLDetailsElement>(
      "details.device-entry:not([open])",
    );
    if (closed.length === 0) {
      return;
    }
    for (const row of closed) {
      row.open = true;
      row.dispatchEvent(new Event("toggle"));
    }
    flush();
  }
}

export function renderDevicesInto(
  container: HTMLElement,
  overrides: Partial<DevicesProps>,
  expandDisclosures = true,
) {
  const props = createDevicesViewProps(overrides);
  const update = fixtures.get(container);
  if (update) {
    update(props);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        fixtures.set(container, (next) => setCurrent(next));
        return <DevicesView {...current()} />;
      },
      { container },
    );
  }
  flush();
  if (expandDisclosures) {
    openDeviceDisclosures(container);
  }
}

export function renderDevicesContainer(
  overrides: Partial<DevicesProps>,
  expandDisclosures = true,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  renderDevicesInto(container, overrides, expandDisclosures);
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
  return row.matches(".device-entry__summary") ? (row.closest(".device-entry") ?? row) : row;
}
