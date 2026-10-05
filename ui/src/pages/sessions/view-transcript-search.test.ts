/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildMultiResult, buildProps } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

describe("sessions transcript search view", () => {
  it.each([true, false])(
    "keeps transcript submission separate from roster filtering (available=%s)",
    async (available) => {
      const container = document.createElement("div");
      const onTranscriptSearchChange = vi.fn();
      const onTranscriptSearch = vi.fn();
      render(
        renderSessions({
          ...buildProps(buildMultiResult([])),
          searchQuery: "agent label",
          transcriptSearchAvailable: available,
          transcriptSearchQuery: available ? "  exact phrase  " : "hidden",
          onTranscriptSearchChange,
          onTranscriptSearch,
        }),
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
    render(
      renderSessions({
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
      }),
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
