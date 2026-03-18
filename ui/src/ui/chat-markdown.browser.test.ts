import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat markdown rendering", () => {
  it("renders markdown inside tool output sidebar", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          { type: "toolcall", name: "noop", arguments: {} },
          { type: "toolresult", name: "noop", text: "Hello **world**" },
        ],
        timestamp,
      },
    ];

    await app.updateComplete;

    const toolCards = Array.from(app.querySelectorAll<HTMLElement>(".chat-tool-card"));
    const toolCard = toolCards.find((card) =>
      card.querySelector(".chat-tool-card__preview, .chat-tool-card__inline"),
    );
    expect(toolCard).not.toBeUndefined();
    toolCard?.click();

    await app.updateComplete;

    const strongNodes = Array.from(app.querySelectorAll(".sidebar-markdown strong"));
    expect(strongNodes.map((node) => node.textContent)).toContain("world");
  });

  it("shows tool call request parameters in the sidebar", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const timestamp = Date.now();
    app.chatMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolcall",
            name: "sessions_spawn",
            arguments: { agentId: "research", prompt: "hello" },
          },
        ],
        timestamp,
      },
    ];

    await app.updateComplete;

    const toolCard = app.querySelector<HTMLElement>(".chat-tool-card");
    expect(toolCard).not.toBeNull();
    toolCard?.click();

    await app.updateComplete;

    const sidebar = app.querySelector(".sidebar-markdown");
    expect(sidebar?.textContent).toContain("Arguments");
    expect(sidebar?.textContent).toContain("agentId");
    expect(sidebar?.textContent).toContain("research");
    expect(sidebar?.textContent).toContain("prompt");
    expect(sidebar?.textContent).toContain("hello");
  });
});
