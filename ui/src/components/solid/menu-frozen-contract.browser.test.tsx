import { cleanup } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  item,
  mountMenu,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import type { MenuItem } from "./menu.tsx";

afterEach(cleanup);

// These cases carry the remaining owner-boundary contracts from the frozen
// dropdown suites; direct Web Awesome callers still use the original suites.
describe("Solid menu frozen dropdown contracts", () => {
  it("keeps native autofocus on an input inside grouped content", async () => {
    mountMenu({
      children: (
        <div>
          <input aria-label="Filter actions" autofocus />
        </div>
      ),
    });
    await openMenu();
    expect(document.activeElement).toBe(surface().querySelector("input"));
  });

  it.each(["item", "input"] as const)(
    "preserves newer %s focus across opening completion",
    async (target) => {
      const view = mountMenu({ children: <input aria-label="Filter actions" /> });
      expect(view.handle.open()).toBe(true);
      const focused = target === "item" ? item("Archive") : surface().querySelector("input")!;
      focused.focus();
      await phase(surface(), "open");
      expect(document.activeElement).toBe(focused);
      expect(openSurfaces()).toEqual([surface()]);
    },
  );

  it("preserves keyboard selection while the root is still opening", async () => {
    const selected: string[] = [];
    const view = mountMenu({ onSelect: (entry) => selected.push(entry.id) });
    expect(view.handle.open()).toBe(true);
    item("Archive").focus();
    await userEvent.keyboard("{Enter}");
    await phase(surface(), "hidden");
    expect(selected).toEqual(["archive"]);
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps descendants when the same ancestor receives another open request", async () => {
    const view = mountMenu({
      items: [
        {
          id: "more",
          label: "More",
          children: [
            {
              id: "inner",
              label: "Inner",
              children: [{ id: "deep", label: "Deep action" }],
            },
          ],
        },
      ],
    });
    await openMenu();
    await openMenu("people-more");
    await openMenu("people-more-inner");
    const more = [...view.handle.overlay.children].find((child) => child.id === "people-more")!;
    expect(more.request(true)).toBe(true);
    expect(more.request(true)).toBe(true);
    expect(openSurfaces()).toHaveLength(3);
    expect(document.activeElement).toBe(item("Deep action", "people-more-inner"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(trigger("people-more-inner"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(trigger("people-more"));
  });

  it("retires disabled descendants on root close and permits a fresh branch opening", async () => {
    const [disabled, setDisabled] = createSignal(false);
    const entries = (): readonly MenuItem[] => [
      {
        id: "more",
        label: "More",
        children: [
          {
            id: "inner",
            label: "Inner",
            disabled: disabled(),
            children: [{ id: "deep", label: "Deep action" }],
          },
        ],
      },
    ];
    const view = mountMenu({
      get items() {
        return entries();
      },
    });
    await openMenu();
    await openMenu("people-more");
    await openMenu("people-more-inner");
    setDisabled(true);
    flush();
    expect(view.handle.close()).toBe(true);
    await phase(surface(), "hidden");
    expect(openSurfaces()).toEqual([]);
    expect(surface("people-more").inert).toBe(true);
    expect(surface("people-more-inner").inert).toBe(true);
    setDisabled(false);
    flush();
    await openMenu();
    await openMenu("people-more");
    await openMenu("people-more-inner");
    expect(document.activeElement).toBe(item("Deep action", "people-more-inner"));
  });
});
