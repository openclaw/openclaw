/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildMultiResult, buildProps } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

describe("session category controls", () => {
  it.each(["Research", "__new-group__"])(
    "assigns group %s without confusing the create action",
    async (category) => {
      const container = document.createElement("div");
      const onAssignCategory = vi.fn();
      const onRequestNewCategory = vi.fn();
      render(
        renderSessions({
          ...buildProps(
            buildMultiResult([
              { key: "agent:main:discord:channel:1", kind: "group", updatedAt: 2 },
              { key: "agent:main:main", kind: "direct", updatedAt: 1, category },
            ]),
          ),
          groupBy: "category",
          knownCategories: [category],
          onAssignCategory,
          onRequestNewCategory,
        }),
        container,
      );
      await Promise.resolve();

      const headers = Array.from(container.querySelectorAll(".session-group-row__label")).map(
        (el) => el.textContent?.trim(),
      );
      expect(headers).toEqual([category, "Ungrouped"]);

      // The populated category renders before the ungrouped row.
      const select = container.querySelectorAll<HTMLSelectElement>(
        'select[aria-label="Move session to a group"]',
      )[1];
      if (!select) {
        throw new Error("Expected group select");
      }
      select.value = category;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onAssignCategory).toHaveBeenCalledWith("agent:main:discord:channel:1", category);

      select.selectedIndex = select.options.length - 1;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onRequestNewCategory).toHaveBeenCalledWith("agent:main:discord:channel:1");
      expect(select.value).toBe("");

      const headerRow = container.querySelector(".session-group-row");
      if (!headerRow) {
        throw new Error("Expected group header row");
      }
      const dropWithPayload = (types: string[], data: Record<string, string>) => {
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(drop, "dataTransfer", {
          value: { types, getData: (type: string) => data[type] ?? "" },
        });
        headerRow.dispatchEvent(drop);
      };

      // Generic text drags (e.g. selected page text) must not trigger patches.
      dropWithPayload(["text/plain"], { "text/plain": "not-a-session" });
      expect(onAssignCategory).toHaveBeenCalledTimes(1);

      dropWithPayload(["application/x-openclaw-session-key"], {
        "application/x-openclaw-session-key": "agent:main:main",
      });
      expect(onAssignCategory).toHaveBeenCalledWith("agent:main:main", category);
    },
  );

  it("disables category assignment controls without group write access", async () => {
    const container = document.createElement("div");
    const onAssignCategory = vi.fn();
    const reason = "Operator write access is required.";
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            { key: "agent:main:main", kind: "direct", updatedAt: 1, category: "Research" },
          ]),
        ),
        groupBy: "category",
        knownCategories: ["Research"],
        groupWriteDisabledReason: reason,
        onAssignCategory,
      }),
      container,
    );
    await Promise.resolve();

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Move session to a group"]',
    );
    expect(select?.disabled).toBe(true);
    expect(select?.title).toBe(reason);
    if (select) {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const headerRow = container.querySelector(".session-group-row");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["application/x-openclaw-session-key"],
        getData: () => "agent:main:main",
      },
    });
    headerRow?.dispatchEvent(drop);

    expect(onAssignCategory).not.toHaveBeenCalled();
  });
});
