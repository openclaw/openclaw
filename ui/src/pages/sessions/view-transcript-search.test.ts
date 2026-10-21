/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOverlay, type Overlay } from "../../components/overlay-lifecycle.ts";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import {
  disposeSessionViews,
  renderSessionsView,
  buildMultiResult,
  buildProps,
} from "./view.test-support.tsx";

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
});
afterEach(() => {
  disposeSessionViews();
  container.remove();
});
const render = (props: Partial<ReturnType<typeof buildProps>>) =>
  renderSessionsView({ ...buildProps(buildMultiResult([])), ...props }, container);

const unavailable = "Connect to the Gateway to search transcripts.";
const connectionStatus = () => container.querySelector('.settings-section__desc [role="status"]');
const transcriptTrigger = () =>
  container.querySelector<HTMLButtonElement>(".sessions-transcript-search__trigger");
const filterInput = () =>
  container.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;
const escapeKey = (options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...options });

describe("sessions transcript search view", () => {
  it.each([true, false])(
    "keeps transcript submission separate from roster filtering (available=%s)",
    async (available) => {
      const onTranscriptSearchChange = vi.fn();
      const onTranscriptSearch = vi.fn();
      render({
        searchQuery: "agent label",
        transcriptSearchAvailable: available,
        transcriptSearchQuery: available ? "  exact phrase  " : "hidden",
        onTranscriptSearchChange,
        onTranscriptSearch,
      });
      await Promise.resolve();

      const rosterFilter = container.querySelector<HTMLInputElement>(
        '.sessions-filter-popover__search input[type="text"]',
      );
      const trigger = transcriptTrigger();
      expect(rosterFilter?.value).toBe("agent label");
      expect(rosterFilter?.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
      expect(trigger?.getAttribute("aria-label")).toBe(
        available ? "Search transcripts" : unavailable,
      );
      expect(trigger?.disabled).toBe(!available);
      expect(container.querySelector(".sessions-transcript-search__input input")).toBeNull();
      expect(connectionStatus()?.textContent).toBe(available ? undefined : unavailable);
      if (available) {
        trigger!.click();
        await Promise.resolve();
        const transcriptInput = container.querySelector<HTMLInputElement>(
          '.sessions-transcript-search__input input[type="search"]',
        );
        expect(transcriptInput?.value).toBe("  exact phrase  ");
        transcriptInput!.value = "different words";
        transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
        expect(onTranscriptSearch).not.toHaveBeenCalled();
        container
          .querySelector(".sessions-transcript-search__form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        expect(trigger?.closest("openclaw-tooltip")).toBeNull();
        render({ transcriptSearchAvailable: true });
        await Promise.resolve();
        expect(connectionStatus()).toBeNull();
        expect(transcriptTrigger()?.disabled).toBe(false);
      }
      expect(onTranscriptSearch).toHaveBeenCalledTimes(available ? 1 : 0);
    },
  );

  it("renders transcript provenance and opens the matching session", async () => {
    const onNavigateToChat = vi.fn();
    const session = { key: "agent:main:launch", kind: "direct" as const, label: "Launch planning" };
    const timestamp = Date.parse("2026-07-12T12:00:00.000Z");
    render({
      ...buildProps(buildMultiResult([{ ...session, updatedAt: timestamp }])),
      transcriptSearchQuery: "launch code",
      transcriptSearch: {
        status: "results",
        sessions: [session],
        results: [
          {
            sessionKey: "agent:main:launch",
            sessionId: "session-launch",
            messageId: "message-1",
            role: "assistant",
            timestamp,
            snippet: "The <launch code> is ready.",
            score: 1,
          },
        ],
        indexing: true,
        truncated: true,
        archivedTranscriptsExcluded: 0,
      },
      onNavigateToChat,
    });
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
      document.body.append(container);
      const onFilterChange = vi.fn();
      const onClearFilters = vi.fn();
      const props = {
        searchQuery: "missing",
        statusFilter: "archived" as const,
        activeMinutes: "60",
        limit: "25",
        includeGlobal: false,
        groupBy: "category" as const,
        onClearFilters,
        onFiltersChange: onFilterChange,
        onStatusFilterChange: onFilterChange,
      };
      const onSearchChange = vi.fn((value: string) => {
        props.searchQuery = value;
        render({ ...props, onSearchChange });
      });

      render({ ...props, onSearchChange });
      container.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger")!.click();
      const input = filterInput();
      const clear = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear search"]',
      )!;
      expect(clear).toMatchObject({ hidden: false, disabled: false });
      if (action === "click") {
        clear.focus();
        clear.click();
      } else {
        input.focus();
        const event = escapeKey();
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
      expect(input.value).toBe("");
      expect(document.activeElement).toBe(input);
      expect(clear).toMatchObject({ hidden: true, disabled: true });
      expect(onFilterChange).not.toHaveBeenCalled();
      expect(onClearFilters).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLInputElement>(".session-filter-input--limit")?.value).toBe(
        "25",
      );
      expect(container.querySelector<HTMLSelectElement>(".session-groupby__select")?.value).toBe(
        "category",
      );
      const emptyEscape = escapeKey();
      input.dispatchEvent(emptyEscape);
      expect(emptyEscape.defaultPrevented).toBe(true);
      expect(container.querySelector(".sessions-filter-popover")?.matches(":popover-open")).toBe(
        false,
      );
      expect(onSearchChange).toHaveBeenCalledTimes(1);
      container.querySelector<HTMLButtonElement>(".data-table-empty-state button")!.click();
      expect(onClearFilters).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "composing",
    "IME keycode",
    "prevented",
    "unfocused",
    "modified",
    "session menu",
    "menu",
    "closed menu",
    "popover",
    "modal",
    "shell modal",
  ])("leaves Escape to its existing owner when %s", (owner) => {
    document.body.append(container);
    const onSearchChange = vi.fn();
    const props = { ...buildProps(buildMultiResult([])), searchQuery: "keep me", onSearchChange };
    let overlay: HTMLElement | undefined;
    let overlayOwner: Overlay | undefined;
    let releaseModal: (() => void) | undefined;
    try {
      if (owner === "session menu") {
        props.sessionMenu = { key: "agent:main:main" };
      }
      render(props);
      container.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger")!.click();
      const input = filterInput();
      if (owner !== "unfocused") {
        input.focus();
      }
      if (["menu", "closed menu", "popover", "modal", "shell modal"].includes(owner)) {
        overlay = document.createElement(
          owner.endsWith("menu") ? "openclaw-menu-surface" : owner === "modal" ? "dialog" : "div",
        );
        if (owner === "popover") {
          overlay.popover = "manual";
        }
        if (owner === "modal") {
          overlay.setAttribute("open", "");
        }
        if (owner === "shell modal") {
          overlay.className = "shell-nav";
          overlay.setAttribute("aria-modal", "true");
        }
        document.body.append(overlay);
        if (owner === "closed menu") {
          overlay.hidePopover();
        }
        if (owner === "popover") {
          overlayOwner = createOverlay("sessions-search-test", undefined, { dismissEscape: false });
          overlayOwner.bindSurface(overlay);
          overlayOwner.bindTrigger(input);
          expect(overlayOwner.request(true, "none")).toBe(true);
        }
        if (owner === "modal" || owner === "shell modal") {
          releaseModal = registerModalSurface(overlay);
        }
      }
      const event = escapeKey({
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
      if (owner === "prevented") {
        expect(event.defaultPrevented).toBe(true);
      }
    } finally {
      overlayOwner?.dispose();
      releaseModal?.();
      overlay?.removeAttribute("open");
      overlay?.remove();
    }
  });
});
