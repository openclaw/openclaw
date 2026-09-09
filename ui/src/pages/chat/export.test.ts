import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatMarkdown, exportChatMarkdown } from "./export.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportChatMarkdown", () => {
  it("reports an empty transcript without creating a download", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    expect(exportChatMarkdown([], "OpenClaw")).toBe("empty");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads one readable Markdown file for a populated transcript", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chat-export");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(
      exportChatMarkdown(
        [
          { role: "user", content: "What can you export?", timestamp: 1_000 },
          { role: "assistant", content: "A readable conversation.", timestamp: 2_000 },
        ],
        "OpenClaw",
      ),
    ).toBe("downloaded");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:chat-export");
    expect((createObjectURL.mock.calls[0]![0] as Blob).type).toBe("text/markdown");
    const markdown = await (createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(markdown).toContain("# Chat with OpenClaw");
    expect(markdown).toContain("## You");
    expect(markdown).toContain("What can you export?");
    expect(markdown).toContain("## OpenClaw");
    expect(markdown).toContain("A readable conversation.");
  });

  it("uses transcript speaker normalization without inventing timestamps or exporting silent replies", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "USER",
          senderLabel: "Kai (123e4567-e89b-12d3-a456-426614174000)",
          content: "Please check the build.",
        },
        {
          role: "ASSISTANT",
          __openclaw: { senderName: "Build assistant" },
          content: [{ type: "output_text", text: "The build passed." }],
          timestamp: 1_000,
        },
        { role: "tool_result", content: "exit 0" },
        { role: "assistant", content: "NO_REPLY" },
      ],
      "OpenClaw",
    );

    expect(markdown).toBe(
      "# Chat with OpenClaw\n\n" +
        "## Kai\n\nPlease check the build.\n\n" +
        "## Build assistant (1970-01-01T00:00:01.000Z)\n\nThe build passed.\n\n" +
        "## Tool\n\nexit 0\n",
    );
  });

  it.each([
    {
      name: "empty string tool envelope",
      message: { role: "assistant", toolCallId: "", content: "Visible body" },
      speaker: "Tool",
    },
    {
      name: "tool content inside a user message",
      message: {
        role: "user",
        content: [null, { type: "text", text: "Visible body" }, { type: "tool_result" }],
      },
      speaker: "Tool",
    },
    {
      name: "non-string tool envelope",
      message: { role: "assistant", toolCallId: 0, content: "Visible body" },
      speaker: "OpenClaw",
    },
  ])("keeps canonical speaker classification for $name", ({ message, speaker }) => {
    expect(buildChatMarkdown([message], "OpenClaw")).toBe(
      `# Chat with OpenClaw\n\n## ${speaker}\n\nVisible body\n`,
    );
  });

  it.each(["string", "blocks", "text"])(
    "preserves imported %s content and explicit attribution independently of display normalization",
    (shape) => {
      const body = "    indented code\n\nMEDIA:https://example.invalid/report.pdf";
      const framed =
        '<<<EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>\nSource: External\n---\n' +
        body +
        '\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="1234567890abcdef">>>';
      const message = {
        role: "assistant",
        senderLabel: "Imported assistant (123e4567-e89b-12d3-a456-426614174000)",
        __openclaw: { idempotencyKey: "fixture-catalog:thread:message", senderName: "Other name" },
        timestamp: "1000",
        ...(shape === "text"
          ? { text: framed }
          : { content: shape === "blocks" ? [{ type: "output_text", text: framed }] : framed }),
      };
      const original = structuredClone(message);

      expect(buildChatMarkdown([message], "OpenClaw")).toBe(
        `# Chat with OpenClaw\n\n## Imported assistant\n\n${body}\n`,
      );
      expect(message).toEqual(original);
    },
  );
});
