/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

describe("tool detail sidebar", () => {
  it.each([
    {
      name: "browser.open",
      args: undefined,
      content: "## Browser.open\n\n**Tool:** `browser.open`\n\n### Tool output\nOpened page",
    },
    {
      name: "read",
      args: { path: "/notes/Project · Notes.md" },
      content: expect.stringContaining("**Summary:** with from /notes/Project · Notes.md"),
    },
    {
      name: "web_search",
      args: { query: "Project · Notes" },
      content: expect.stringContaining('**Summary:** with for "Project · Notes"'),
    },
  ])("opens $name details with literal output", ({ name, args, content }) => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
    render(
      renderToolCard(
        {
          id: "msg:tool:full",
          name,
          args,
          outputText: "Opened page",
          messageId: "msg-tool-full",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn(), onOpenSidebar },
      ),
      container,
    );

    container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();

    expect(onOpenSidebar).toHaveBeenCalledOnce();
    expect(onOpenSidebar.mock.calls[0]?.[0]).toEqual({
      kind: "markdown",
      content,
      rawText: "Opened page",
    });
  });
});
