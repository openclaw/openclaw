import { describe, expect, it } from "vitest";
import { isLeakedInternalHistoryMessage } from "./history-filter.ts";

describe("isLeakedInternalHistoryMessage", () => {
  it("keeps legitimate System-prefixed chat text with generic exec wording", () => {
    expect(
      isLeakedInternalHistoryMessage({
        role: "assistant",
        content: [{ type: "text", text: "System: exec failed after deploy, retrying" }],
      }),
    ).toBe(false);
  });

  it("hides timestamped leaked Control UI exec rows", () => {
    expect(
      isLeakedInternalHistoryMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "System (untrusted): [2026-04-14 22:56:23 PDT] Exec completed (tidy-zep, code 0)",
          },
        ],
      }),
    ).toBe(true);
  });

  it("hides leaked sender metadata rows for openclaw-control-ui", () => {
    expect(
      isLeakedInternalHistoryMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: 'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[2026-04-14 22:56:23 PDT] Exec completed',
          },
        ],
      }),
    ).toBe(true);
  });
});
