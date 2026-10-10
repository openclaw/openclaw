/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildMultiResult, buildProps } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

describe("Sessions query clearing", () => {
  it.each(["click", "Escape"])(
    "clears only the query with %s and returns focus to search",
    (action) => {
      const container = document.createElement("div");
      document.body.append(container);
      const props = {
        ...buildProps(buildMultiResult([])),
        searchQuery: "missing",
        statusFilter: "archived" as const,
        activeMinutes: "60",
        limit: "25",
        includeGlobal: false,
        groupBy: "category" as const,
        onClearFilters: vi.fn(),
        onFiltersChange: vi.fn(),
        onStatusFilterChange: vi.fn(),
      };
      const onSearchChange = vi.fn((query: string) => {
        props.searchQuery = query;
        render(renderSessions({ ...props, onSearchChange }), container);
      });
      try {
        render(renderSessions({ ...props, onSearchChange }), container);
        const input = container.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
        expect(input.getAttribute("aria-label")).toBe("Search sessions");
        const clear = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Clear search"]',
        )!;
        expect(clear).not.toBeNull();
        if (action === "click") {
          clear.focus();
          clear.click();
        } else {
          input.focus();
          const event = new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
        expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
        expect(input.value).toBe("");
        expect(document.activeElement).toBe(input);
        expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();
        expect(props.onClearFilters).not.toHaveBeenCalled();
        expect(props.onFiltersChange).not.toHaveBeenCalled();
        expect(props.onStatusFilterChange).not.toHaveBeenCalled();
        expect(
          container.querySelector<HTMLInputElement>(".session-filter-input--limit")?.value,
        ).toBe("25");
        expect(container.querySelector<HTMLSelectElement>(".session-groupby__select")?.value).toBe(
          "category",
        );
        const emptyEscape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(emptyEscape);
        expect(emptyEscape.defaultPrevented).toBe(false);
        expect(onSearchChange).toHaveBeenCalledTimes(1);
        container.querySelector<HTMLButtonElement>(".data-table-empty-state button")!.click();
        expect(props.onClearFilters).toHaveBeenCalledOnce();
      } finally {
        container.remove();
      }
    },
  );

  it.each([
    "composing",
    "IME keycode",
    "prevented",
    "unfocused",
    "modified",
    "menu",
    "popover",
    "modal",
  ])("leaves Escape to its existing owner when %s", (owner) => {
    const container = document.createElement("div");
    document.body.append(container);
    const onSearchChange = vi.fn();
    const props = { ...buildProps(buildMultiResult([])), searchQuery: "keep me", onSearchChange };
    let overlay: HTMLElement | undefined;
    try {
      render(renderSessions(props), container);
      const input = container.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
      if (owner !== "unfocused") {
        input.focus();
      }
      if (owner === "menu") {
        overlay = document.createElement("openclaw-menu-surface");
        document.body.append(overlay);
      }
      if (owner === "popover") {
        container.querySelector("wa-popover")!.setAttribute("open", "");
      }
      if (owner === "modal") {
        overlay = document.createElement("dialog");
        overlay.setAttribute("open", "");
        document.body.append(overlay);
      }
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        isComposing: owner === "composing",
        keyCode: owner === "IME keycode" ? 229 : 0,
        ctrlKey: owner === "modified",
      });
      if (owner === "prevented") {
        event.preventDefault();
      }
      input.dispatchEvent(event);
      expect(onSearchChange).not.toHaveBeenCalled();
      expect(input.value).toBe("keep me");
      expect(event.defaultPrevented).toBe(owner === "prevented");
    } finally {
      container.querySelector("wa-popover")?.removeAttribute("open");
      overlay?.remove();
      container.remove();
    }
  });
});
