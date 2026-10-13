/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeSessionViews,
  renderSessionsView,
  buildMultiResult,
  buildProps,
} from "./view.test-support.tsx";

afterEach(disposeSessionViews);

describe("sessions transcript search view", () => {
  it.each([true, false])(
    "keeps transcript submission separate from roster filtering (available=%s)",
    async (available) => {
      const container = document.createElement("div");
      const onTranscriptSearchChange = vi.fn();
      const onTranscriptSearch = vi.fn();
      renderSessionsView(
        {
          ...buildProps(buildMultiResult([])),
          searchQuery: "agent label",
          transcriptSearchAvailable: available,
          transcriptSearchQuery: available ? "  exact phrase  " : "hidden",
          onTranscriptSearchChange,
          onTranscriptSearch,
        },
        container,
      );
      await Promise.resolve();

      const rosterFilter = container.querySelector<HTMLInputElement>(
        '.sessions-filter-bar input[type="text"]',
      );
      const transcriptInput = container.querySelector<HTMLInputElement>(
        '.sessions-transcript-search input[type="search"]',
      );
      expect(rosterFilter?.value).toBe("agent label");
      expect(rosterFilter?.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
      expect(transcriptInput?.value).toBe(available ? "  exact phrase  " : "hidden");
      expect(transcriptInput?.disabled).toBe(!available);
      if (available) {
        transcriptInput!.value = "different words";
        transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
        expect(onTranscriptSearch).not.toHaveBeenCalled();
      } else {
        expect(container.textContent).toContain("Transcript search requires a newer Gateway.");
      }

      container
        .querySelector(".sessions-transcript-search__form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(onTranscriptSearch).toHaveBeenCalledTimes(available ? 1 : 0);
    },
  );

  it("renders transcript provenance and opens the matching session", async () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();
    renderSessionsView(
      {
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:launch",
              kind: "direct",
              label: "Launch planning",
              updatedAt: Date.parse("2026-07-12T12:00:00.000Z"),
            },
          ]),
        ),
        transcriptSearchQuery: "launch code",
        transcriptSearch: {
          status: "results",
          sessions: [{ key: "agent:main:launch", kind: "direct", label: "Launch planning" }],
          results: [
            {
              sessionKey: "agent:main:launch",
              sessionId: "session-launch",
              messageId: "message-1",
              role: "assistant",
              timestamp: Date.parse("2026-07-12T12:00:00.000Z"),
              snippet: "The <launch code> is ready.",
              score: 1,
            },
          ],
          indexing: true,
          truncated: true,
          archivedTranscriptsExcluded: 0,
        },
        onNavigateToChat,
      },
      container,
    );
    await Promise.resolve();

    const result = container.querySelector<HTMLButtonElement>(
      ".sessions-transcript-search__result",
    );
    expect(result?.textContent).toContain("Launch planning");
    expect(result?.textContent).toContain("Assistant");
    expect(result?.textContent).toContain("The <launch code> is ready.");
    expect(result?.querySelector("launch")).toBeNull();
    expect(container.textContent).toContain("The transcript index is still updating");
    expect(container.textContent).toContain("Showing the first 25 matches.");

    result?.click();
    expect(onNavigateToChat).toHaveBeenCalledWith("agent:main:launch");
  });
});

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
        renderSessionsView({ ...props, onSearchChange }, container);
      });
      try {
        renderSessionsView({ ...props, onSearchChange }, container);
        const input = container.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
        expect(input.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
        const clear = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Clear search"]',
        )!;
        expect(clear).not.toBeNull();
        expect(clear.hidden).toBe(false);
        expect(clear.disabled).toBe(false);
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
        expect(clear.hidden).toBe(true);
        expect(clear.disabled).toBe(true);
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
      renderSessionsView(props, container);
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
