import { createSignal, type Setter } from "solid-js";
import { expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionUsageCreator } from "../../../../src/shared/usage-types.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
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

function mountCreators(creator: SessionUsageCreator, onSelect = (_key: string | null) => {}) {
  return mountView(() =>
    UsageCreators({
      groups: [group(creator)],
      selectedKey: null,
      mode: "cost",
      onSelect,
    }),
  ).container;
}

function mountLiveCreators(groups: ReturnType<typeof group>[]) {
  type Props = Parameters<typeof UsageCreators>[0];
  let update!: Setter<Props>;
  const view = mountView(() => {
    const [props, setProps] = createSignal<Props>({
      groups,
      mode: "tokens",
      selectedKey: null,
      onSelect: vi.fn(),
    });
    update = setProps;
    return UsageCreators({
      get groups() {
        return props().groups;
      },
      get mode() {
        return props().mode;
      },
      get selectedKey() {
        return props().selectedKey;
      },
      get onSelect() {
        return props().onSelect;
      },
    });
  });
  return { ...view, update };
}

const rankedCreators = () =>
  Array.from({ length: 12 }, (_, index) =>
    group(human(String(index), `Creator ${index}`), (12 - index) * 100, 12 - index),
  );

it("retains creator tables, rows, focus and the expanded disclosure when the metric changes", () => {
  const { container, update } = mountLiveCreators(rankedCreators());
  const tables = [...container.querySelectorAll("table")];
  const rows = [...container.querySelectorAll("tbody tr")];
  const more = container.querySelector("details")!;
  more.open = true;
  const focused = rows[9]!.querySelector("button")!;
  focused.focus();

  update((props) => ({ ...props, mode: "cost" }));
  flush();

  expect(
    [...container.querySelectorAll("table")].filter((table, index) => table === tables[index]),
  ).toHaveLength(2);
  expect(
    [...container.querySelectorAll("tbody tr")].filter((row, index) => row === rows[index]),
  ).toHaveLength(12);
  expect(document.activeElement).toBe(focused);
  expect(container.querySelector("details")).toBe(more);
  expect(more.open).toBe(true);
  expect(container.querySelectorAll("td:nth-child(3).usage-creator-primary")).toHaveLength(12);
});

it("updates retained creator identities and actions through refresh, reordering and the More boundary", () => {
  const initial = rankedCreators();
  const { container, update } = mountLiveCreators(initial);
  const rows = [...container.querySelectorAll("tbody tr")];
  const more = container.querySelector("details")!;
  more.open = true;
  const onSelect = vi.fn();
  const refreshed = initial.map((entry, index) =>
    group(
      human(String(index), `Updated ${index}`),
      entry.totals.totalTokens * 2,
      entry.totals.totalCost * 3,
      4,
    ),
  );
  update((props) => ({ ...props, groups: refreshed, selectedKey: initial[9]!.key, onSelect }));
  flush();

  expect(
    [...container.querySelectorAll("tbody tr")].filter((row, index) => row === rows[index]),
  ).toHaveLength(12);
  expect(texts(rows[9]!, "td")).toEqual(["600", "$9.00", "4"]);
  expect(rows[9]!.textContent).toContain("Updated 9");
  expect(rows[9]!.classList.contains("selected")).toBe(true);
  expect(rows[9]!.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
  expect(rows[0]!.querySelector<HTMLElement>(".usage-creator-track span")!.style.width).toBe(
    `${(2400 / 15600) * 100}%`,
  );
  rows[9]!.querySelector("button")!.click();
  expect(onSelect).toHaveBeenLastCalledWith(initial[9]!.key);

  const reordered = refreshed.map((entry, index) =>
    group(
      entry,
      entry.totals.totalTokens,
      index === 9 ? 100 : index === 6 ? 99 : index === 0 ? 1 : 12 - index,
      entry.sessionCount,
    ),
  );
  update((props) => ({ ...props, groups: reordered, mode: "cost" }));
  flush();
  expect(texts(container, ".usage-creator-name > span:last-child")).toEqual([
    "Updated 9",
    "Updated 6",
    "Updated 1",
    "Updated 2",
    "Updated 3",
    "Updated 4",
    "Updated 5",
    "Updated 7",
    "Updated 8",
    "Updated 10",
    "Updated 0",
    "Updated 11",
  ]);
  expect(container.querySelectorAll("tbody tr")[1]).toBe(rows[6]);
  expect(container.querySelectorAll("tbody tr")[9]).toBe(rows[10]);
  expect(container.querySelector("details")).toBe(more);
  expect(more.open).toBe(true);
  container.querySelector<HTMLButtonElement>("tbody button")!.click();
  expect(onSelect).toHaveBeenLastCalledWith(initial[9]!.key);
  expect(container.querySelector("tbody tr")!.classList.contains("selected")).toBe(true);

  const top = container.querySelector("table")!;
  const topRows = [...top.querySelectorAll("tbody tr")];
  update((props) => ({
    ...props,
    groups: reordered.filter((_, index) => (index > 0 && index < 8) || index === 9),
  }));
  flush();
  expect(container.querySelector("table")).toBe(top);
  expect(
    [...top.querySelectorAll("tbody tr")].filter((row, index) => row === topRows[index]),
  ).toHaveLength(8);
  expect(container.querySelector("details")).toBeNull();
  update((props) => ({ ...props, groups: reordered }));
  flush();
  expect(
    [...top.querySelectorAll("tbody tr")].filter((row, index) => row === topRows[index]),
  ).toHaveLength(8);
  expect(container.querySelector("details")!.open).toBe(false);
});

it("keeps creator choices and opaque identities through row, picker, and search actions", async () => {
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
  const trigger = container.querySelector<HTMLButtonElement>(".usage-creator-trigger")!;
  const picker = container.querySelector<HTMLElement>(".usage-creator-filter")!;
  const open = async () => {
    trigger.click();
    await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  };
  expect(trigger.getAttribute("aria-label")).toBe("Filter by session creator");
  expect(trigger.textContent).toContain("Alex Morgan");
  await open();
  expect(
    [...picker.querySelectorAll('[role="menuitemradio"]')].map((item) =>
      item.getAttribute("aria-label"),
    ),
  ).toEqual(["Alex Morgan", "Jordan Lee"]);
  expect(picker.querySelector('[aria-label="Alex Morgan"]')?.getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(container.textContent).not.toContain("opaque-");
  const row = container.querySelector("tbody tr")!;
  expect(texts(row, "td")).toEqual(["1.2K", "$2.50", "3"]);
  const rowButton = row.querySelector("button")!;
  expect(rowButton.getAttribute("aria-pressed")).toBe("true");
  rowButton.click();
  expect(onSelect).toHaveBeenLastCalledWith(alex.key);

  setOptions([]);
  flush();
  expect(container.querySelector(".usage-creator-trigger")).toBe(trigger);
  expect(trigger.textContent).toContain("Selected identity");
  expect(
    picker.querySelector('[aria-label="Selected identity"]')?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(container.textContent).not.toContain(alex.key);
  [...picker.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Clear")!
    .click();
  expect(onSelect).toHaveBeenLastCalledWith(null);

  setOptions([alex, jordan]);
  flush();
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await open();
  }
  const search = picker.querySelector<HTMLInputElement>("input")!;
  search.value = "Jordan";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(
    [...picker.querySelectorAll('[role="menuitemradio"]')].map((item) =>
      item.getAttribute("aria-label"),
    ),
  ).toEqual(["Jordan Lee"]);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSelect).toHaveBeenLastCalledWith(jordan.key);
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  await open();
  picker.querySelector<HTMLButtonElement>('[aria-label="Alex Morgan"]')!.click();
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it.each([
  { actor: undefined, label: "Not recorded" },
  { actor: { type: "system" as const }, label: "System" },
])("labels $label attribution explicitly without displaying the filter key", ({ actor, label }) => {
  const onSelect = vi.fn<(key: string | null) => void>();
  const container = mountCreators({ key: "unattributed:opaque-key", actor }, onSelect);
  const button = container.querySelector<HTMLButtonElement>("tbody button")!;
  expect(button.textContent).toContain(label);
  expect(container.textContent).not.toContain("opaque-key");
  expect(container.textContent).toContain("not by who sent each message");
  button.click();
  expect(onSelect).toHaveBeenCalledWith("unattributed:opaque-key");
});

it.each([
  ["telegram:group:-100123:topic:2051", "Telegram group · topic 2051"],
  ["200482621", "Telegram user 200482621"],
  ["telegram:200482621", "Telegram user 200482621"],
  ["telegram:group:-100123", "Telegram group"],
])("names the legacy channel creator %s as %s", (id, label) => {
  const container = mountCreators({
    key: JSON.stringify(["human", "channel", "main", "telegram", "default", id]),
    actor: {
      type: "human",
      id,
      identity: { type: "legacy", actorType: "human", source: null, id },
    },
  });
  // Raw sender ids read as people and places, never as opaque keys.
  expect(container.querySelector(".usage-creator-name")?.textContent).toContain(label);
});
