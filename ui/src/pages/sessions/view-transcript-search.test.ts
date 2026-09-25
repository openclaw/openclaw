/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildMultiResult, buildProps } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

describe("sessions transcript search view", () => {
  it("keeps transcript search distinct from the loaded-roster filter", async () => {
    const container = document.createElement("div");
    const onTranscriptSearchChange = vi.fn();
    const onTranscriptSearch = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        searchQuery: "agent label",
        transcriptSearchQuery: "  exact phrase  ",
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
    expect(transcriptInput?.value).toBe("  exact phrase  ");

    transcriptInput!.value = "different words";
    transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
    expect(onTranscriptSearch).not.toHaveBeenCalled();

    container
      .querySelector(".sessions-transcript-search__form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onTranscriptSearch).toHaveBeenCalledOnce();
  });

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

  it("disables transcript search when the Gateway does not advertise it", async () => {
    const container = document.createElement("div");
    const onTranscriptSearch = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildMultiResult([])),
        transcriptSearchAvailable: false,
        transcriptSearchQuery: "hidden",
        onTranscriptSearch,
      }),
      container,
    );
    await Promise.resolve();

    expect(
      container.querySelector<HTMLInputElement>('.sessions-transcript-search input[type="search"]')
        ?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("Transcript search requires a newer Gateway.");
    container
      .querySelector(".sessions-transcript-search__form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onTranscriptSearch).not.toHaveBeenCalled();
  });
});
