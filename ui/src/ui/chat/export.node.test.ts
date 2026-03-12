import { describe, expect, it } from "vitest";
import { buildChatExportFilename, buildChatMarkdown, sanitizeFilenameComponent } from "./export.ts";

describe("chat export hardening", () => {
  it("escapes raw HTML in exported markdown content and labels", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "assistant",
          content: "<img src=x onerror=alert(1)><script>alert(2)</script>",
          timestamp: Date.UTC(2026, 2, 11, 12, 0, 0),
        },
      ],
      "Bot </script><script>alert(3)</script>",
    );

    expect(markdown).toContain(
      "# Chat with Bot &lt;/script&gt;&lt;script&gt;alert(3)&lt;/script&gt;",
    );
    expect(markdown).toContain(
      "## Bot &lt;/script&gt;&lt;script&gt;alert(3)&lt;/script&gt; (2026-03-11T12:00:00.000Z)",
    );
    expect(markdown).toContain(
      "&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;",
    );
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<img");
  });

  it("sanitizes the downloaded filename component", () => {
    expect(sanitizeFilenameComponent("../NUL\t<script>alert(1)</script>")).toBe(
      "NUL scriptalert1-script",
    );
    expect(buildChatExportFilename("../NUL\t<script>alert(1)</script>", 123)).toBe(
      "chat-NUL scriptalert1-script-123.md",
    );
  });
});
