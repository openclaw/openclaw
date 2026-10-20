import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionUsageCreator } from "../../../../src/shared/usage-types.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { UsageCreatorFilter, UsageCreators } from "./view-creators.tsx";

function group(creator: SessionUsageCreator, totalTokens = 0, totalCost = 0, sessionCount = 2) {
  return {
    ...creator,
    totals: { ...createEmptyCostUsageTotals(), totalTokens, totalCost },
    sessionCount,
    daily: [],
    sessionActivity: [],
  };
}

function selectIdentity(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

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
  const [options, setOptions] = createSignal<SessionUsageCreator[]>([alex, jordan]);
  const { container } = mountSolid(() => [
    UsageCreatorFilter({
      get options() {
        return options();
      },
      selectedKey: alex.key,
      onSelect,
    }),
    UsageCreators({
      groups: [group(alex, 1200, 2.5, 3)],
      selectedKey: alex.key,
      mode: "tokens",
      onSelect,
    }),
  ]);
  flush();

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

  setOptions([]);
  flush();
  const unavailable = container.querySelector("select")!;
  expect(unavailable).toBe(select);
  expect(unavailable.value).toBe(alex.key);
  expect(unavailable.selectedOptions[0]?.textContent?.trim()).toBe("Selected identity");
  expect(container.textContent).not.toContain(alex.key);
  selectIdentity(unavailable, "");
  expect(onSelect).toHaveBeenLastCalledWith(null);

  setOptions([alex, jordan]);
  flush();
  selectIdentity(select, jordan.key);
  expect(onSelect).toHaveBeenLastCalledWith(jordan.key);
  selectIdentity(select, "");
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it.each([
  { actor: undefined, label: "Unattributed" },
  { actor: { type: "system" as const }, label: "System" },
])("labels $label attribution explicitly without displaying the filter key", ({ actor, label }) => {
  const onSelect = vi.fn<(key: string | null) => void>();
  const { container } = mountSolid(() =>
    UsageCreators({
      groups: [group({ key: "unattributed:opaque-key", actor })],
      selectedKey: null,
      mode: "cost",
      onSelect,
    }),
  );
  flush();

  const button = container.querySelector<HTMLButtonElement>("tbody button")!;
  expect(button.textContent).toContain(label);
  expect(container.textContent).not.toContain("opaque-key");
  expect(container.textContent).toContain("not per-turn billing");
  button.click();
  expect(onSelect).toHaveBeenCalledWith("unattributed:opaque-key");
});
