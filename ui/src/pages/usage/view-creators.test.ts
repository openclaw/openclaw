/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionUsageCreator } from "../../../../src/shared/usage-types.js";
import { renderUsageCreatorFilter, renderUsageCreators } from "./view-creators.ts";

afterEach(() => {
  document.body.replaceChildren();
});

it("keeps an unavailable selected identity distinct from All when a date range removes its option", () => {
  const selected: SessionUsageCreator = {
    key: "opaque-selected",
    actor: { type: "human", id: "alex", label: "Alex" },
  };
  const onSelect = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderUsageCreatorFilter({ options: [selected], selectedKey: selected.key, onSelect }),
    container,
  );
  render(renderUsageCreatorFilter({ options: [], selectedKey: selected.key, onSelect }), container);
  const select = container.querySelector("select")!;
  expect(select.value).toBe(selected.key);
  expect(select.selectedOptions[0]?.textContent?.trim()).toBe("Selected identity");
  expect(container.textContent).not.toContain(selected.key);
  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onSelect).toHaveBeenCalledWith(null);
});

it("keeps all creator choices after filtering and passes opaque identities through row and select actions", () => {
  const alex: SessionUsageCreator = {
    key: "profile:opaque-alex",
    actor: {
      type: "human",
      id: "alex",
      identity: { type: "profile", id: "alex" },
      label: "Alex Morgan",
    },
  };
  const jordan: SessionUsageCreator = {
    key: "profile:opaque-jordan",
    actor: { type: "human", id: "jordan", label: "Jordan Lee" },
  };
  const onSelect = vi.fn<(key: string | null) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  render(
    html`${renderUsageCreatorFilter({ options: [alex, jordan], selectedKey: alex.key, onSelect })}
    ${renderUsageCreators({
      groups: [
        {
          ...alex,
          totals: { ...createEmptyCostUsageTotals(), totalTokens: 1200, totalCost: 2.5 },
          sessionCount: 3,
          daily: [],
          sessionActivity: [],
        },
      ],
      selectedKey: alex.key,
      mode: "tokens",
      onSelect,
    })}`,
    container,
  );

  const select = container.querySelector("select")!;
  expect(select.getAttribute("aria-label")).toBe("Filter by session creator");
  expect(select.value).toBe(alex.key);
  expect(Array.from(select.options, (option) => option.textContent?.trim())).toEqual([
    "All identities",
    "Alex Morgan",
    "Jordan Lee",
  ]);
  expect(container.textContent).not.toContain("opaque-");
  const row = container.querySelector("tbody tr")!;
  expect(row.textContent).toContain("1.2K");
  expect(row.textContent).toContain("$2.50");
  expect(row.lastElementChild?.textContent?.trim()).toBe("3");
  const rowButton = row.querySelector("button")!;
  expect(rowButton.getAttribute("aria-pressed")).toBe("true");
  rowButton.click();
  expect(onSelect).toHaveBeenLastCalledWith(alex.key);

  select.value = jordan.key;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onSelect).toHaveBeenLastCalledWith(jordan.key);
  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it.each([
  { actor: undefined, label: "Unattributed" },
  { actor: { type: "system" as const }, label: "System" },
])("labels $label attribution explicitly without displaying the filter key", ({ actor, label }) => {
  const onSelect = vi.fn<(key: string | null) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderUsageCreators({
      groups: [
        {
          key: "unattributed:opaque-key",
          actor,
          totals: createEmptyCostUsageTotals(),
          sessionCount: 2,
          daily: [],
          sessionActivity: [],
        },
      ],
      selectedKey: null,
      mode: "cost",
      onSelect,
    }),
    container,
  );

  const button = container.querySelector<HTMLButtonElement>("tbody button")!;
  expect(button.textContent).toContain(label);
  expect(container.textContent).not.toContain("opaque-key");
  expect(container.textContent).toContain("not per-turn billing");
  button.click();
  expect(onSelect).toHaveBeenCalledWith("unattributed:opaque-key");
});
