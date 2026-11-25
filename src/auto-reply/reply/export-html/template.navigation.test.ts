import { describe, expect, it } from "vitest";
import {
  now,
  renderTemplate,
  requireElement,
  type SessionEntry,
} from "../../../../test/helpers/export-html-template.js";

describe("export html navigation", () => {
  it("renders and navigates a long conversation without losing its messages", async () => {
    const entries: SessionEntry[] = Array.from({ length: 50_000 }, (_, index) => ({
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: now(),
      type: "message",
      message: {
        role: "user",
        content: `Message ${index}`,
        display: index === 0 || index === 49_999,
      },
    }));
    entries.push({
      id: "alternative",
      parentId: "message-0",
      timestamp: "2026-02-23T00:00:00.000Z",
      type: "message",
      message: { role: "user", content: "Alternative branch" },
    });
    const { document } = await renderTemplate({
      header: { id: "long-conversation", timestamp: now() },
      entries,
      leafId: "message-49999",
      systemPrompt: "",
      tools: [],
    });

    expect(
      Array.from(document.querySelectorAll(".tree-node"), (node) => node.getAttribute("data-id")),
    ).toEqual(["message-0", "message-49999", "alternative"]);
    expect(document.querySelectorAll(".user-message")).toHaveLength(2);
    expect(document.getElementById("entry-message-0")?.textContent).toContain("Message 0");
    expect(document.getElementById("entry-message-49999")?.textContent).toContain("Message 49999");

    requireElement(
      document.querySelector<HTMLElement>('.tree-node[data-id="alternative"]'),
      "alternative tree entry missing",
    ).click();
    expect(document.getElementById("entry-alternative")?.textContent).toContain("Alternative branch");
    expect(document.getElementById("entry-message-49999")).toBeNull();

    requireElement(
      document.querySelector<HTMLElement>('.tree-node[data-id="message-0"]'),
      "first tree entry missing",
    ).click();
    expect(document.querySelector(".tree-node.active")?.getAttribute("data-id")).toBe("message-0");
    expect(document.querySelectorAll(".user-message")).toHaveLength(2);
    expect(document.getElementById("entry-message-49999")?.textContent).toContain("Message 49999");
  });
});
