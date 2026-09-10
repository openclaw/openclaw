import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderTaskActivityFeed } from "./chat-task-activity-feed.ts";

afterEach(() => document.body.replaceChildren());

function mount(messages: unknown[]) {
  const container = document.body.appendChild(document.createElement("div"));
  render(renderTaskActivityFeed(messages), container);
  return container;
}

function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(toolCallId: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: "Result body must not appear" }],
  };
}

describe("task activity feed", () => {
  it("renders user text plainly and assistant markdown with links and code", () => {
    const container = mount([
      { role: "user", content: "Please **inspect** [the renderer](https://example.com)." },
      {
        role: "assistant",
        content: "Found the [owner](https://example.com/owner).\n\n```ts\nconst ready = true;\n```",
      },
    ]);
    const user = container.querySelector(".chat-task-feed__user");
    expect(user?.textContent).toContain("Please inspect the renderer.");
    expect(user?.querySelector("strong, a")).toBeNull();
    expect(container.querySelector('a[href="https://example.com/owner"]')?.textContent).toBe(
      "owner",
    );
    expect(container.querySelector("pre code")?.textContent).toContain("const ready = true;");
    expect(container.querySelector(".chat-avatar, .chat-bubble, .chat-author-avatar")).toBeNull();
  });

  it("groups consecutive calls across result messages and expands every command or path", () => {
    const container = mount([
      {
        role: "assistant",
        content: [
          toolCall("exec-1", "exec", {
            command: "pnpm tsgo --project tsconfig.gateway.json\npnpm lint:ui:styles --fix",
          }),
        ],
      },
      toolResult("exec-1"),
      {
        role: "assistant",
        content: [
          toolCall("exec-2", "exec", { command: "pnpm lint:ui:styles" }),
          toolCall("read-1", "read", { path: "ui/src/styles/chat/sidebar.css" }),
        ],
      },
      toolResult("read-1"),
      { role: "assistant", content: "The next step is the layout fix." },
      {
        role: "assistant",
        content: [
          toolCall("edit-1", "edit", {
            path: "ui/src/styles/chat/sidebar.css",
            oldText: "display: flex",
            newText: "display: grid",
          }),
        ],
      },
    ]);
    const groups = container.querySelectorAll<HTMLDetailsElement>(
      "details.chat-task-feed__tool-group",
    );
    expect(groups).toHaveLength(2);
    const group = groups[0]!;
    const summary = group.querySelector("summary")!;
    expect(summary.textContent).toContain("pnpm tsgo --project tsconfig.gateway.json");
    expect(summary.textContent).not.toContain("--fix");
    expect(summary.textContent).toContain("Ran 2 commands, read a file");
    expect(group.open).toBe(false);
    summary.click();
    expect(group.open).toBe(true);
    // Expanded rows keep the complete multi-line command, not just its first line.
    expect(
      group.querySelector(".chat-task-feed__calls .chat-task-feed__tool-line--full")?.textContent,
    ).toContain("pnpm tsgo --project tsconfig.gateway.json\npnpm lint:ui:styles --fix");
    expect(group.textContent).toContain("pnpm lint:ui:styles");
    expect(group.textContent).toContain("ui/src/styles/chat/sidebar.css");
    expect(group.querySelectorAll(".chat-task-feed__tool-line").length).toBeGreaterThanOrEqual(3);
    summary.click();
    expect(group.open).toBe(false);
    expect(container.textContent).not.toContain("Result body must not appear");
  });

  it.each(["arguments", "args", "input"])(
    "renders and groups untyped calls carrying %s",
    (argumentField) => {
      const messages = [
        {
          role: "assistant",
          content: [
            { id: "untyped-exec-1", name: "exec", [argumentField]: { command: "pnpm check:ui" } },
            {
              id: "untyped-exec-2",
              name: "exec",
              [argumentField]: { command: "pnpm lint:ui:styles" },
            },
          ],
        },
      ];
      for (const block of messages[0]!.content) {
        Object.freeze(block);
      }
      Object.freeze(messages[0]!.content);
      const container = mount(messages);
      const groups = container.querySelectorAll(".chat-task-feed__tool-group");
      expect(groups).toHaveLength(1);
      expect(groups[0]?.querySelector("summary")?.textContent).toContain("pnpm check:ui");
      expect(groups[0]?.querySelector("summary")?.textContent).toContain("Ran 2 commands");
      expect(
        [...groups[0]!.querySelectorAll(".chat-task-feed__tool-line")].map((line) =>
          line.textContent?.trim(),
        ),
      ).toEqual(expect.arrayContaining(["pnpm check:ui", "pnpm lint:ui:styles"]));
    },
  );

  it("preserves mixed-block order and associates late failure results with their call", () => {
    const container = mount([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Before the command." },
          toolCall("failed-call", "exec", { command: "pnpm check:ui" }),
          { type: "text", text: "After the command." },
          toolCall("successful-call", "read", { path: "ui/package.json" }),
        ],
      },
      toolResult("successful-call"),
      toolResult("failed-call", true),
    ]);
    const entries = [...container.querySelectorAll(".chat-task-feed__entry")];
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual([
      expect.stringContaining("Before the command."),
      expect.stringContaining("pnpm check:ui"),
      expect.stringContaining("After the command."),
      expect.stringContaining("ui/package.json"),
    ]);
    const failed = [...container.querySelectorAll(".chat-task-feed__tool-line")].filter((line) =>
      line.textContent?.includes("pnpm check:ui"),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((line) => line.classList.contains("chat-task-feed__error"))).toBe(true);
    const successful = [...container.querySelectorAll(".chat-task-feed__tool-line")].find((line) =>
      line.textContent?.includes("ui/package.json"),
    );
    expect(successful?.classList.contains("chat-task-feed__error")).toBe(false);
  });

  it.each(["tool", "function", "toolResult", "tool_result", undefined])(
    "omits an orphan %s result when the page starts after its call",
    (role) => {
      const container = mount([
        {
          ...(role ? { role } : {}),
          toolCallId: "call-on-previous-page",
          toolName: "read",
          content: [{ type: "text", text: "Orphan result body must not appear" }],
        },
        { role: "assistant", content: "The file confirms the layout contract." },
      ]);
      expect(container.textContent).not.toContain("Orphan result body");
      expect(container.textContent).toContain("The file confirms the layout contract.");
      expect(container.querySelectorAll(".chat-task-feed__entry")).toHaveLength(1);
      expect(container.querySelector(".chat-task-feed__tool-group")).toBeNull();
    },
  );

  it("omits commentary text while retaining a call in the same assistant message", () => {
    const container = mount([
      {
        role: "assistant",
        phase: "commentary",
        content: [
          { type: "text", text: "Commentary before the call must not appear" },
          toolCall("commentary-call", "read", { path: "ui/src/styles/chat/sidebar.css" }),
          { type: "text", text: "Commentary after the call must not appear" },
        ],
      },
      toolResult("commentary-call"),
      { role: "assistant", phase: "final_answer", content: "The stylesheet owns the layout." },
    ]);
    expect(container.textContent).not.toContain("Commentary");
    expect(container.textContent).not.toContain("Result body must not appear");
    expect(container.querySelectorAll(".chat-task-feed__tool-group")).toHaveLength(1);
    expect(container.querySelector(".chat-task-feed__tool-group summary")?.textContent).toContain(
      "ui/src/styles/chat/sidebar.css",
    );
    expect(container.textContent).toContain("The stylesheet owns the layout.");
    expect(container.querySelectorAll(".chat-task-feed__entry")).toHaveLength(2);
  });

  it("shows local HH:MM message timestamps and omits missing timestamps", () => {
    const timestamp = new Date(2026, 8, 10, 9, 7).getTime();
    const container = mount([
      { role: "user", content: "Timestamped prompt", timestamp },
      { role: "assistant", content: "No timestamp" },
      { role: "assistant", content: "Later timestamp", timestamp: timestamp + 60_000 },
    ]);
    expect(
      [...container.querySelectorAll(".chat-task-feed__time")].map((time) => time.textContent),
    ).toEqual(["09:07", "09:08"]);
    const unclocked = [...container.querySelectorAll(".chat-task-feed__entry")].find((entry) =>
      entry.textContent?.includes("No timestamp"),
    );
    expect(unclocked?.querySelector(".chat-task-feed__time")).toBeNull();
  });

  it("names media without previews and omits private thinking blocks", () => {
    const container = mount([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Private reasoning must not appear" },
          {
            type: "image",
            name: "layout.png",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
          },
          { type: "file", name: "report.txt", mimeType: "text/plain" },
          { type: "text", text: "Attachment review complete." },
        ],
      },
    ]);
    expect(container.textContent).toContain("layout.png");
    expect(container.textContent).toContain("report.txt");
    expect(container.textContent).toContain("Attachment review complete.");
    expect(container.textContent).not.toContain("Private reasoning");
    expect(container.querySelector("img, iframe, video")).toBeNull();
  });
});
