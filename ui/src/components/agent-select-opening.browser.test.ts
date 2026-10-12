import { afterEach, describe, expect, it, vi } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "../test-helpers/load-styles.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import { AgentSelect } from "./agent-select.ts";
import type { AgentSelectOption } from "./agent-select.ts";

class OpeningAgentSelect extends AgentSelect {}
customElements.define(`test-agent-select-opening-${crypto.randomUUID()}`, OpeningAgentSelect);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function fixture(
  value = "main",
  options: AgentSelectOption[] = [
    { value: "main", label: "Main" },
    { value: "research", label: "Research" },
  ],
  onCreateAgent: (() => void) | null = null,
) {
  const select = new OpeningAgentSelect();
  select.options = options;
  select.onCreateAgent = onCreateAgent;
  select.value = value;
  document.body.append(select);
  await select.updateComplete;
  const dropdown = select.querySelector("wa-dropdown")!;
  await dropdown.updateComplete;
  const items = [...select.querySelectorAll("wa-dropdown-item")];
  await Promise.all(items.map((item) => item.updateComplete));
  const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(outside);
  let shown = false;
  dropdown.addEventListener(
    "wa-after-show",
    () => {
      shown = true;
    },
    { once: true },
  );
  const item = (index: number) => {
    const entry = items[index];
    if (!entry) {
      throw new Error(`Missing dropdown fixture item ${index}`);
    }
    return entry;
  };
  return { select, dropdown, items, item, menu, outside, shown: () => shown };
}

describe("Agent select opening focus", () => {
  it("does not reinitialize focus after a canceled hide", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture("research");
    f.dropdown.open = true;
    await expect.poll(f.shown).toBe(true);
    expect(document.activeElement).toBe(f.items[1]);
    f.dropdown.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });
    f.dropdown.open = false;
    await f.dropdown.updateComplete;
    await f.dropdown.updateComplete;
    expect(f.dropdown.open).toBe(true);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(f.items[0]);
  });

  it("leaves focus outside after a canceled show and initializes a later accepted opening", async () => {
    const f = await fixture("research");
    f.outside.focus();
    f.dropdown.addEventListener("wa-show", (event) => event.preventDefault(), { once: true });
    f.dropdown.open = true;
    await f.dropdown.updateComplete;
    await f.dropdown.updateComplete;
    expect(f.dropdown.open).toBe(false);
    expect(document.activeElement).toBe(f.outside);
    expect(f.shown()).toBe(false);
    f.dropdown.open = true;
    await expect.poll(f.shown).toBe(true);
    expect(document.activeElement).toBe(f.items[1]);
  });

  it.each(["missing", "disabled", "create"] as const)(
    "uses the first enabled item for a %s selection",
    async (kind) => {
      const f = await fixture(
        kind === "missing" ? "absent" : "main",
        kind === "create"
          ? []
          : [
              { value: "main", label: "Main", disabled: true },
              { value: "research", label: "Research" },
            ],
        kind === "create" ? () => {} : null,
      );
      f.dropdown.open = true;
      await expect.poll(f.shown).toBe(true);
      expect(document.activeElement).toBe(kind === "create" ? f.items[0] : f.items[1]);
      expect(f.items.filter((item) => item.active)).toEqual([
        kind === "create" ? f.items[0] : f.items[1],
      ]);
    },
  );

  it.each(["reopen", "reconnect"] as const)(
    "initializes selected focus after a fast %s without retaining old ownership",
    async (kind) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture("research");
      f.dropdown.open = true;
      await expect.poll(f.shown).toBe(true);
      let shownAgain = false;
      f.dropdown.addEventListener("wa-after-show", () => (shownAgain = true), { once: true });
      if (kind === "reopen") {
        await duringElementAnimation(
          f.menu,
          "hide",
          () => (f.dropdown.open = false),
          () => {
            f.dropdown.open = true;
          },
        );
      } else {
        f.select.remove();
        f.outside.focus();
        document.body.append(f.select);
      }
      await expect.poll(() => shownAgain).toBe(true);
      expect(document.activeElement).toBe(f.items[1]);
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(f.items[0]);
    },
  );

  it("preserves a pointer selection made during opening", async () => {
    const { page } = await import("vitest/browser");
    const f = await fixture("research");
    const values: string[] = [];
    f.select.onSelect = (value) => values.push(value);
    const hidden = new Promise<void>((resolve) => {
      f.dropdown.addEventListener("wa-after-hide", () => resolve(), { once: true });
    });
    await duringElementAnimation(
      f.menu,
      "show",
      () => (f.dropdown.open = true),
      () => page.elementLocator(f.item(0)).click(),
    );
    await hidden;
    expect(values).toEqual(["main"]);
    expect(f.dropdown.open).toBe(false);
    expect(document.activeElement).toBe(f.select.querySelector("button"));
  });

  it.each(["outside", "selected"] as const)(
    "honors %s focus acquired while the popup renders",
    async (target) => {
      const f = await fixture("research");
      const popup = f.dropdown.shadowRoot!.querySelector("wa-popup")!;
      const update = popup.updateComplete;
      let rendered!: () => void;
      const gate = new Promise<boolean>((resolve) => {
        rendered = () => resolve(true);
      });
      // Pause the actual render boundary before dropdown focus initialization.
      Object.defineProperty(popup, "updateComplete", { configurable: true, value: gate });
      try {
        f.dropdown.open = true;
        await f.dropdown.updateComplete;
        if (target === "outside") {
          f.outside.focus();
          await update;
        } else {
          await update;
          f.item(1).focus();
        }
      } finally {
        Reflect.deleteProperty(popup, "updateComplete");
        rendered();
      }
      await expect.poll(f.shown).toBe(true);
      expect(document.activeElement).toBe(target === "outside" ? f.outside : f.item(1));
      if (target === "selected") {
        expect(f.items.map((item) => item.active)).toEqual([false, true]);
      }
    },
  );

  it.each([
    { kind: "first", value: "main", initial: 0, final: 1, key: "{ArrowDown}" },
    { kind: "selected", value: "research", initial: 1, final: 0, key: "{ArrowUp}" },
    { kind: "nested events", value: "research", initial: 1, final: 0, key: "{ArrowUp}" },
    { kind: "outside focus", value: "main", initial: 0, final: 0, key: "" },
  ])(
    "preserves $kind input across opening completion",
    async ({ kind, value, initial, final, key }) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture(value);
      const scroll = vi.spyOn(f.item(initial), "scrollIntoView");
      await duringElementAnimation(
        f.menu,
        "show",
        () => (f.dropdown.open = true),
        async () => {
          if (kind === "outside focus") {
            f.outside.focus();
            return;
          }
          if (kind === "nested events") {
            f.item(1).dispatchEvent(new CustomEvent("wa-show", { bubbles: true }));
            f.item(1).dispatchEvent(new CustomEvent("wa-hide", { bubbles: true }));
          } else {
            expect(document.activeElement).toBe(f.items[initial]);
          }
          if (kind === "selected") {
            expect(f.items.map((item) => item.active)).toEqual([false, true]);
            expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
          }
          await userEvent.keyboard(key);
          if (kind !== "nested events") {
            expect(document.activeElement).toBe(f.items[final]);
          }
        },
      );
      await expect.poll(f.shown).toBe(true);
      expect(document.activeElement).toBe(kind === "outside focus" ? f.outside : f.items[final]);
    },
  );
});
