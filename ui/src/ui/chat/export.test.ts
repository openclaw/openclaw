/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { buildChatMarkdown } from "./export.ts";

describe("buildChatMarkdown", () => {
  it("omits leaked internal history rows from exports", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "System (untrusted): [2026-04-14 22:56:23 PDT] Exec completed (tidy-zep, code 0)",
            },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "real reply" }],
          timestamp: 2,
        },
      ],
      "OpenClaw",
    );

    expect(markdown).toContain("real reply");
    expect(markdown).not.toContain("System (untrusted)");
    expect(markdown).not.toContain("Exec completed");
  });

  it("keeps legitimate System-prefixed chat text with generic exec wording in exports", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "System: exec failed after deploy, retrying" }],
          timestamp: 1,
        },
      ],
      "OpenClaw",
    );

    expect(markdown).toContain("System: exec failed after deploy, retrying");
  });

  it("keeps quoted reset-instruction text that only matches the shared prefix in exports", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "A new session was started via /new or /reset. If runtime-provided startup context is included for this first turn, use it before responding to the user. Can you explain what this instruction means?",
            },
          ],
          timestamp: 1,
        },
      ],
      "OpenClaw",
    );

    expect(markdown).toContain("A new session was started via /new or /reset.");
    expect(markdown).toContain("Can you explain what this instruction means?");
  });
});
