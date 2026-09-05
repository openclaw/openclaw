/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { icons } from "./icons.ts";
import { renderCompactSessionMenuNavigationItem } from "./session-menu-compact.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("compact session menu", () => {
  it("keeps every navigation label in the default slot and accessible name", () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(
      html`
        ${renderCompactSessionMenuNavigationItem({
          value: "compact:open-group",
          label: "Move to group",
          icon: icons.folder,
        })}
        ${renderCompactSessionMenuNavigationItem({
          value: "compact:open-plain",
          label: "Plain row",
        })}
        ${renderCompactSessionMenuNavigationItem({
          value: "compact:open-specific-owner",
          label: "Specific owner",
          details: html`<span class="viewer-avatar">A</span>`,
          accessibleLabel: "Specific owner: Ada",
        })}
      `,
      container,
    );

    const items = [...container.querySelectorAll("wa-dropdown-item")];
    expect(
      items.map((item) => item.querySelector(":scope > .session-menu__text")?.textContent?.trim()),
    ).toEqual(["Move to group", "Plain row", "Specific owner"]);
    expect(
      items.map(
        (item) =>
          item.getAttribute("aria-label") ??
          item.querySelector(":scope > .session-menu__text")?.textContent?.trim(),
      ),
    ).toEqual(["Move to group", "Plain row", "Specific owner: Ada"]);
    expect(items.map((item) => item.querySelectorAll(":scope > [slot='icon']").length)).toEqual([
      1, 0, 0,
    ]);
    expect(items[2]?.querySelector(":scope > [slot='details'] .viewer-avatar")).not.toBeNull();
  });
});
