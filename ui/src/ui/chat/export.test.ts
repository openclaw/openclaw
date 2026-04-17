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
});
