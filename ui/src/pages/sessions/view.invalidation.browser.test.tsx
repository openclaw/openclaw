import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildMultiResult, buildProps } from "./view.test-support.tsx";
import { SessionsView } from "./view.tsx";
import "../../styles.css";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it("retains native label selection and undo without value writes during row metadata refreshes", async () => {
  await page.viewport(1440, 900);
  const result = buildMultiResult([
    { key: "agent:main:editing", label: "Original", kind: "direct", updatedAt: 2 },
    { key: "agent:main:sibling", label: "Sibling", kind: "direct", updatedAt: 1 },
  ]);
  const initial = {
    ...buildProps(result),
    expandedSessionKey: result.sessions[0]!.key,
    onPatch: vi.fn(),
  };
  const [current, setCurrent] = createSignal(initial);
  const view = mountSolid(() => <SessionsView {...current()} />);
  const input = view.container.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
  await userEvent.click(input);
  await userEvent.keyboard("{End}x");
  expect(input.value).toBe("Originalx");
  input.setSelectionRange(2, 5);
  const setter = vi.spyOn(input, "value", "set");
  setCurrent((previous) => ({
    ...previous,
    refreshing: true,
    result: {
      ...result,
      sessions: [
        { ...result.sessions[0]!, kind: "group", unread: true },
        { ...result.sessions[1]!, label: "Updated sibling" },
      ],
    },
  }));
  flush();
  expect(view.container.querySelector(".session-overrides-grid input")).toBe(input);
  expect(input.value).toBe("Originalx");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(setter).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Updated sibling");
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(input.value).toBe("Original");
  expect(initial.onPatch).not.toHaveBeenCalled();
  setCurrent((previous) => ({ ...previous, loading: true }));
  flush();
  expect(input.disabled).toBe(true);
  expect(setter).not.toHaveBeenCalled();
  setCurrent((previous) => ({ ...previous, loading: false }));
  flush();
  expect(input.disabled).toBe(false);
  expect(setter).not.toHaveBeenCalled();
  setCurrent((previous) => ({
    ...previous,
    result: {
      ...result,
      sessions: [{ ...result.sessions[0]!, label: "Authoritative" }, result.sessions[1]!],
    },
  }));
  flush();
  expect(input.value).toBe("Authoritative");
  expect(setter).toHaveBeenCalledTimes(1);
});

it.each([1280, 390])(
  "windows rows while retaining native focus, details, and page selection at %i px",
  async (width) => {
    await page.viewport(width, 900);
    const result = buildMultiResult(
      Array.from({ length: 100 }, (_, index) => ({
        key: `agent:main:window-${index}`,
        kind: "direct" as const,
        updatedAt: 100 - index,
        category: index < 50 ? "A" : "B",
      })),
    );
    const onSelectPage = vi.fn();
    const [current, setCurrent] = createSignal({
      ...buildProps(result),
      pageSize: 100,
      onSelectPage,
    });
    const view = mountSolid(() => (
      <div class="content" style={{ height: "600px", overflow: "auto" }}>
        <SessionsView {...current()} />
      </div>
    ));
    const rows = () => [
      ...view.container.querySelectorAll<HTMLTableRowElement>(".session-data-row"),
    ];
    await expect.poll(() => rows().length).toBeLessThan(25);
    expect(view.container.querySelector("table")?.getAttribute("aria-rowcount")).toBe("101");
    view.container.querySelector<HTMLInputElement>("thead input")!.click();
    expect(onSelectPage).toHaveBeenCalledWith(result.sessions.map((row) => row.key));
    setCurrent((previous) => ({
      ...previous,
      selectedKeys: new Set(result.sessions.map((row) => row.key)),
    }));
    flush();

    // Entering from the far end of the list must expose the preceding native Tab target.
    rows().at(-1)!.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(
      document.activeElement?.closest(".session-data-row")?.getAttribute("aria-rowindex"),
    ).toBe("100");

    setCurrent((previous) => ({ ...previous, expandedSessionKey: result.sessions[0]!.key }));
    flush();
    const draft = view.container.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
    const scroller = view.container.querySelector<HTMLElement>(".data-table-container")!;
    scroller.style.height = "200px";
    draft.value = "Retained draft";
    draft.focus();
    await expect
      .poll(() => {
        const field = draft.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        return field.top >= viewport.top && field.bottom <= viewport.bottom;
      })
      .toBe(true);
    scroller.scrollTop = scroller.scrollHeight / 2;
    await expect
      .poll(() =>
        rows().some((row) => {
          const index = Number(row.getAttribute("aria-rowindex"));
          return index > 40 && index < 70;
        }),
      )
      .toBe(true);
    scroller.scrollTop = scroller.scrollHeight;
    await expect
      .poll(() => {
        const last = rows().at(-1)!.getBoundingClientRect();
        return last.bottom <= scroller.getBoundingClientRect().bottom + 1;
      })
      .toBe(true);
    expect(view.container.querySelector(".session-overrides-grid input")).toBe(draft);
    expect(draft.value).toBe("Retained draft");
    expect(document.activeElement).toBe(draft);
    expect(rows().length).toBeLessThan(25);

    setCurrent((previous) => ({
      ...previous,
      groupBy: "category",
      knownCategories: ["A", "B", "Empty"],
      expandedSessionKey: result.sessions[49]!.key,
    }));
    flush();
    scroller.scrollTop = 0;
    await expect.poll(() => view.container.querySelector(".session-group-row") !== null).toBe(true);
    expect(rows().length).toBeLessThan(25);
    const groupEnd = () => rows().find((row) => row.textContent?.includes("window-49"));
    await expect.poll(() => Boolean(groupEnd())).toBe(true);
    const groupButton = groupEnd()!.querySelector<HTMLButtonElement>(".icon-btn")!;
    groupButton.focus();
    expect(document.activeElement).toBe(groupButton);
    setCurrent((previous) => ({ ...previous, expandedSessionKey: null }));
    flush();
    await expect
      .poll(() => document.activeElement?.closest(".session-data-row")?.textContent ?? "")
      .toContain("window-49");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.closest(".session-data-row")?.textContent).toContain(
      "window-50",
    );

    scroller.scrollTop = 0;
    await expect
      .poll(() => rows()[0]!.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom)
      .toBe(true);
    view.container.querySelector<HTMLSelectElement>(".data-table-pagination__size")!.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement?.closest(".session-data-row")?.textContent).toContain(
      "window-99",
    );

    // Collapsing an offscreen panel must retire its cached height with its pin.
    setCurrent((previous) => ({ ...previous, expandedSessionKey: result.sessions[49]!.key }));
    flush();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const panelHeight = view.container
      .querySelector<HTMLElement>(".session-details-row")!
      .getBoundingClientRect().height;
    const expandedHeight = scroller.scrollHeight;
    setCurrent((previous) => ({ ...previous, expandedSessionKey: null }));
    flush();
    await expect.poll(() => scroller.scrollHeight).toBeLessThan(expandedHeight - panelHeight + 2);
  },
);
