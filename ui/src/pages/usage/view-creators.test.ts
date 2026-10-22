import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionUsageCreator } from "../../../../src/shared/usage-types.js";
import { flush } from "../../test-helpers/solid-settle.ts";
import { UsageCreatorFilter, UsageCreators } from "./view-creators.tsx";
import { mountView, texts } from "./view-render.test-support.ts";

function human(id: string, label: string, profile = false): SessionUsageCreator {
  const identity = profile ? { type: "profile" as const, id } : undefined;
  return { key: `profile:opaque-${id}`, actor: { type: "human", id, label, identity } };
}

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
  const alex = human("alex", "Alex Morgan", true);
  const jordan = human("jordan", "Jordan Lee");
  const onSelect = vi.fn<(key: string | null) => void>();
  const [options, setOptions] = createSignal<SessionUsageCreator[]>([alex, jordan]);
  const { container } = mountView(() => [
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
  const select = container.querySelector("select")!;
  expect(select.getAttribute("aria-label")).toBe("Filter by session creator");
  expect(select.value).toBe(alex.key);
  expect(texts(select, "option")).toEqual(["All identities", "Alex Morgan", "Jordan Lee"]);
  expect(container.textContent).not.toContain("opaque-");
  const row = container.querySelector("tbody tr")!;
  expect(texts(row, "td")).toEqual(["1.2K", "$2.50", "3"]);
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
  { actor: undefined, label: "Not recorded" },
  { actor: { type: "system" as const }, label: "System" },
])("labels $label attribution explicitly without displaying the filter key", ({ actor, label }) => {
  const onSelect = vi.fn<(key: string | null) => void>();
  const { container } = mountView(() =>
    UsageCreators({
      groups: [group({ key: "unattributed:opaque-key", actor })],
      selectedKey: null,
      mode: "cost",
      onSelect,
    }),
  );
  const button = container.querySelector<HTMLButtonElement>("tbody button")!;
  expect(button.textContent).toContain(label);
  expect(container.textContent).not.toContain("opaque-key");
  expect(container.textContent).toContain("not per-turn billing");
  button.click();
  expect(onSelect).toHaveBeenCalledWith("unattributed:opaque-key");
});

it.each([
  ["telegram:group:-100123:topic:2051", "Telegram group · topic 2051"],
  ["200482621", "Telegram user 200482621"],
  ["telegram:200482621", "Telegram user 200482621"],
  ["telegram:group:-100123", "Telegram group"],
])("names the legacy channel creator %s as %s", (id, label) => {
  const { container } = mountView(() =>
    UsageCreators({
      groups: [
        {
          key: JSON.stringify(["human", "channel", "main", "telegram", "default", id]),
          actor: {
            type: "human",
            id,
            identity: { type: "legacy", actorType: "human", source: null, id },
          },
          totals: createEmptyCostUsageTotals(),
          sessionCount: 1,
          daily: [],
          sessionActivity: [],
        },
      ],
      selectedKey: null,
      mode: "cost",
      onSelect: () => {},
    }),
  );
  // Raw sender ids read as people and places, never as opaque keys.
  expect(container.querySelector(".usage-creator-name")?.textContent).toContain(label);
});
