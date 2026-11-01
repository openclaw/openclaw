import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "./agent-select-registration.ts";
import type { AgentSelectOption } from "./agent-select-types.ts";
import type { AgentSelectElement } from "./agent-select.tsx";

afterEach(() => {
  document.body.replaceChildren();
});
async function fixture(
  value = "research",
  options: AgentSelectOption[] = [
    { value: "main", label: "Main" },
    { value: "research", label: "Research" },
  ],
  bindings: Partial<AgentSelectElement> = {},
) {
  const select = document.createElement("openclaw-agent-select");
  Object.assign(select, { value, options }, bindings);
  document.body.append(select);
  await select.updateComplete;
  const trigger = select.querySelector<HTMLButtonElement>(".agent-select__trigger")!;
  const menu = select.querySelector<HTMLElement>(".agent-select__menu")!;
  const open = async () => {
    await page.elementLocator(trigger).click();
    await expect.poll(() => menu.matches(":popover-open")).toBe(true);
    await expect
      .poll(() => select.querySelector('[role="listbox"]')?.getAttribute("aria-activedescendant"))
      .toBeTruthy();
  };
  return {
    select,
    trigger,
    menu,
    get items() {
      return [...select.querySelectorAll<HTMLElement>('[role="option"]')];
    },
    open,
    get list() {
      return select.querySelector<HTMLElement>('[role="listbox"]')!;
    },
    get active() {
      return select.querySelector<HTMLElement>(
        `[id="${this.list.getAttribute("aria-activedescendant")}"]`,
      );
    },
  };
}

describe("Agent select native menu", () => {
  it.each([false, true])(
    "reveals the initial focus in a long menu (selected disabled: %s)",
    async (disabled) => {
      const f = await fixture(
        "agent-28",
        Array.from({ length: 40 }, (_, index) => ({
          value: `agent-${index}`,
          label: `Agent ${index}`,
          disabled: disabled && index === 28,
        })),
      );
      const shown = new Promise<void>((resolve) => {
        f.menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
      });
      await f.open();
      await shown;
      const row = f.items[disabled ? 0 : 28]!;
      await expect
        .poll(() => {
          const bounds = f.menu.getBoundingClientRect();
          const selected = row.getBoundingClientRect();
          return selected.top >= bounds.top && selected.bottom <= bounds.bottom;
        })
        .toBe(true);
    },
  );
  it.each(["main", "research"])(
    "focuses selected %s and keeps keyboard navigation",
    async (value) => {
      const f = await fixture(value);
      await f.open();
      const index = value === "main" ? 0 : 1;
      expect(document.activeElement).toBe(f.list);
      expect(f.active).toBe(f.items[index]);
      await userEvent.keyboard(index === 0 ? "{ArrowDown}" : "{ArrowUp}");
      await expect.poll(() => f.active).toBe(f.items[1 - index]);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => f.menu.matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(f.trigger);
    },
  );
  it("focuses the first enabled row when the selected row is disabled", async () => {
    const f = await fixture("main", [
      { value: "main", label: "Main", disabled: true },
      { value: "research", label: "Research" },
    ]);
    await f.open();
    await expect.poll(() => f.active).toBe(f.items[1]);
  });
  it("keeps the selected row focused after Enter opens and lets Home move to the first row", async () => {
    const f = await fixture();
    const shown = new Promise<void>((resolve) => {
      f.menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
    });
    f.trigger.focus();
    await userEvent.keyboard("{Enter}");
    await shown;
    await expect.poll(() => f.active).toBe(f.items[1]);
    await userEvent.keyboard("{Home}");
    await expect.poll(() => f.active).toBe(f.items[0]);
  });
  it("rejects disabled selection and closes when disabled while open", async () => {
    const f = await fixture();
    const onSelect = vi.fn();
    f.select.onSelect = onSelect;
    await f.open();
    const retired = f.items[0]!;
    f.select.disabled = true;
    await f.select.updateComplete;
    await expect.poll(() => f.menu.matches(":popover-open")).toBe(false);
    retired.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("respects a vetoed close and restores selected focus after reopening", async () => {
    const f = await fixture();
    await f.open();
    f.menu.addEventListener("overlay-hide", (event) => event.preventDefault(), { once: true });
    await userEvent.keyboard("{Escape}");
    expect(f.menu.matches(":popover-open")).toBe(true);
    await userEvent.keyboard("{ArrowUp}");
    await expect.poll(() => f.active).toBe(f.items[0]);
    await userEvent.keyboard("{Escape}");
    await f.open();
    await expect.poll(() => f.active).toBe(f.items[1]);
  });
  it("reopens after disconnecting an open menu", async () => {
    const f = await fixture();
    await f.open();
    f.select.remove();
    await Promise.resolve();
    document.body.append(f.select);
    await f.select.updateComplete;
    await page.elementLocator(f.select.querySelector(".agent-select__trigger")!).click();
    await expect
      .poll(() => f.select.querySelector(".agent-select__menu")?.matches(":popover-open"))
      .toBe(true);
    const list = f.select.querySelector('[role="listbox"]')!;
    expect(document.activeElement).toBe(list);
    await expect
      .poll(() =>
        f.select
          .querySelector(`[id="${list.getAttribute("aria-activedescendant")}"]`)
          ?.getAttribute("value"),
      )
      .toBe("research");
  });
});

it("selects a different agent, ignores the current value, and preserves empty values", async () => {
  const f = await fixture("research", [
    { value: "", label: "All agents" },
    { value: "research", label: "Research" },
  ]);
  const onSelect = vi.fn();
  f.select.onSelect = onSelect;
  await f.open();
  const selected = f.items[1]!;
  await page.elementLocator(selected).click();
  expect(onSelect).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(f.trigger);
  expect(selected.getAttribute("aria-selected")).toBe("true");
  await f.open();
  await page.elementLocator(f.items[0]!).click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("");
});

it("windows a large catalog while revealing keyboard targets and filtering search", async () => {
  let readTargets: () => readonly string[] = () => [];
  const ensure = vi.fn((_ids: readonly string[]) => {});
  const f = await fixture(
    "agent-250",
    Array.from({ length: 300 }, (_, index) => ({
      value: `agent-${index}`,
      label: `Agent ${String(index).padStart(3, "0")}`,
      agent: { id: `agent-${index}` },
    })),
    {
      identityTargetsRef: (read) => {
        readTargets = read;
      },
      onIdentityTargetsChange: () => ensure(readTargets()),
    },
  );
  const requested = () =>
    [...new Set(ensure.mock.calls.at(-1)?.[0] ?? [])].toSorted((a, b) => a.localeCompare(b));
  const visibleTargets = () =>
    [...new Set(["agent-250", ...f.items.map((item) => item.getAttribute("value"))])].toSorted(
      (a, b) => (a ?? "").localeCompare(b ?? ""),
    );
  await expect.poll(requested).toEqual(["agent-250"]);
  const onSelect = vi.fn();
  f.select.onSelect = onSelect;
  await f.open();
  await expect.poll(() => f.active?.getAttribute("value")).toBe("agent-250");
  await expect.poll(() => f.items.length > 0 && f.items.length < 30).toBe(true);
  expect(f.active?.getAttribute("aria-posinset")).toBe("251");
  expect(f.active?.getAttribute("aria-setsize")).toBe("300");
  await expect.poll(requested).toEqual(visibleTargets());
  await userEvent.keyboard("{End}");
  await expect.poll(() => f.active?.getAttribute("value")).toBe("agent-299");
  await expect.poll(() => requested().includes("agent-299")).toBe(true);
  expect(Math.max(...ensure.mock.calls.map(([ids]) => ids.length))).toBeLessThan(30);
  await userEvent.keyboard("{Home}{ArrowDown}");
  await expect.poll(() => f.active?.getAttribute("value")).toBe("agent-1");
  const search = f.select.querySelector<HTMLButtonElement>(".header-search__toggle")!;
  await page.elementLocator(search).click();
  await userEvent.keyboard("Agent 297");
  await expect.poll(() => f.items.map((item) => item.getAttribute("value"))).toEqual(["agent-297"]);
  await expect.poll(requested).toEqual(["agent-250", "agent-297"]);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("agent-297");
  await expect.poll(() => f.items.length).toBe(0);
  await expect.poll(requested).toEqual(["agent-250"]);
});
