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

  it("keeps quoted reset-instruction text that only matches the shared prefix", () => {
    expect(
      isLeakedInternalHistoryMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "A new session was started via /new or /reset. If runtime-provided startup context is included for this first turn, use it before responding to the user. Can you explain what this instruction means?",
          },
        ],
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

  it("hides the full leaked session reset prompt shape with appended current time", () => {
    expect(
      isLeakedInternalHistoryMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "A new session was started via /new or /reset. If runtime-provided startup context is included for this first turn, use it before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.\nCurrent time: Wednesday, April 15th, 2026 - 11:42 AM (America/Los_Angeles) / 2026-04-15 18:42 UTC",
          },
        ],
      }),
    ).toBe(true);
  });
});
