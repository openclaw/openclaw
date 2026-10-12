/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolFixture as render } from "./chat-tool-render.test-support.ts";

describe("tool detail sidebar", () => {
  it.each([
    { name: "browser.open", args: undefined },
    { name: "read", args: { path: "/notes/Project · Notes.md" } },
    { name: "web_search", args: { query: "Project · Notes" } },
  ])("opens $name details with literal output and identity", async ({ name, args }) => {
    const container = document.createElement("div");
    const onOpenSidebar = vi.fn<(content: SidebarContent) => void>();
    const card = {
      id: "msg:tool:full",
      name,
      args,
      outputText: "  Opened page <strong>literal</strong>\r\n",
      messageId: "msg-tool-full",
      resultMessageId: "result-message",
      callId: "tool-call",
    };
    await render(
      renderToolCard(card, {
        messageKey: "test-message",
        sessionKey: "global",
        agentId: "work",
        expanded: true,
        onToggleExpanded: vi.fn(),
        onOpenSidebar,
      }),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();
    expect(onOpenSidebar).toHaveBeenCalledOnce();
    expect(onOpenSidebar.mock.calls[0]?.[0]).toEqual({
      kind: "tool-output",
      card,
      sessionKey: "global",
      agentId: "work",
    });
  });
});
