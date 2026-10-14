import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "./agent-select-registration.ts";
import type { AgentSelectOption } from "./agent-select.ts";

afterEach(() => {
  document.body.replaceChildren();
});
async function fixture(
  value = "research",
  options: AgentSelectOption[] = [
    { value: "main", label: "Main" },
    { value: "research", label: "Research" },
  ],
  onCreateAgent: (() => void) | null = null,
) {
  const select = document.createElement("openclaw-agent-select");
  Object.assign(select, { value, options, onCreateAgent });
  document.body.append(select);
  await select.updateComplete;
  const trigger = select.querySelector<HTMLButtonElement>(".agent-select__trigger")!;
  const menu = select.querySelector<HTMLElement>('[role="menu"]')!;
  const items = [
    ...select.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [data-create-agent]'),
  ];
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  outside.style.cssText = "position:fixed;right:10px;bottom:10px";
  document.body.append(outside);
  const open = async () => {
    await page.elementLocator(trigger).click();
    await expect.poll(() => menu.matches(":popover-open")).toBe(true);
  };
  return { select, trigger, menu, items, outside, open };
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
      const bounds = f.menu.getBoundingClientRect();
      const selected = row.getBoundingClientRect();
      expect(selected.top).toBeGreaterThanOrEqual(bounds.top);
      expect(selected.bottom).toBeLessThanOrEqual(bounds.bottom);
    },
  );
  it.each(["main", "research"])(
    "focuses selected %s and keeps keyboard navigation",
    async (value) => {
      const f = await fixture(value);
      await f.open();
      const index = value === "main" ? 0 : 1;
      expect(document.activeElement).toBe(f.items[index]);
      await userEvent.keyboard(index === 0 ? "{ArrowDown}" : "{ArrowUp}");
      expect(document.activeElement).toBe(f.items[1 - index]);
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => f.menu.matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(f.trigger);
    },
  );
  it.each(["disabled", "create"])("focuses first enabled %s row", async (kind) => {
    const f = await fixture(
      "main",
      kind === "create"
        ? []
        : [
            { value: "main", label: "Main", disabled: true },
            { value: "research", label: "Research" },
          ],
      kind === "create" ? () => {} : null,
    );
    await f.open();
    expect(document.activeElement).toBe(f.items[kind === "create" ? 0 : 1]);
  });
  it("keeps the selected row focused after Enter opens and lets Home move to the first row", async () => {
    const f = await fixture();
    const shown = new Promise<void>((resolve) => {
      f.menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
    });
    f.trigger.focus();
    await userEvent.keyboard("{Enter}");
    await shown;
    expect(document.activeElement).toBe(f.items[1]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(f.items[0]);
  });
  it("rejects disabled selection and closes when disabled while open", async () => {
    const f = await fixture();
    const onSelect = vi.fn();
    f.select.onSelect = onSelect;
    await f.open();
    f.select.disabled = true;
    await f.select.updateComplete;
    await expect.poll(() => f.menu.matches(":popover-open")).toBe(false);
    f.items[0]!.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("respects a vetoed close and restores selected focus after reopening", async () => {
    const f = await fixture();
    await f.open();
    f.menu.addEventListener("overlay-hide", (event) => event.preventDefault(), { once: true });
    await userEvent.keyboard("{Escape}");
    expect(f.menu.matches(":popover-open")).toBe(true);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(f.items[0]);
    await userEvent.keyboard("{Escape}");
    await f.open();
    expect(document.activeElement).toBe(f.items[1]);
  });
  it("dismisses on outside pointer input and reopens after reconnect", async () => {
    const f = await fixture();
    await f.open();
    await page.elementLocator(f.outside).click();
    await expect.poll(() => f.menu.matches(":popover-open")).toBe(false);
    f.select.remove();
    await Promise.resolve();
    document.body.append(f.select);
    await f.select.updateComplete;
    await page.elementLocator(f.select.querySelector(".agent-select__trigger")!).click();
    await expect
      .poll(() => f.select.querySelector('[role="menu"]')?.matches(":popover-open"))
      .toBe(true);
    expect(document.activeElement?.getAttribute("value")).toBe("research");
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
  await page.elementLocator(f.items[1]!).click();
  expect(onSelect).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(f.trigger);
  expect(f.items[1]!.getAttribute("aria-checked")).toBe("true");
  await f.open();
  await page.elementLocator(f.items[0]!).click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("");
});

it("opens the new-agent flow from its footer item", async () => {
  const onCreate = vi.fn();
  const f = await fixture("research", undefined, onCreate);
  await f.open();
  await page.elementLocator(f.items.at(-1)!).click();
  expect(onCreate).toHaveBeenCalledOnce();
});
