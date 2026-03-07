import { describe, expect, it } from "vitest";
import { parseSteerInput } from "./shared.js";

describe("parseSteerInput", () => {
  it("preserves non-option instruction tokens while normalizing unicode-dash flags", () => {
    const parsed = parseSteerInput([
      "\u2014session",
      "agent:codex:acp:s1",
      "\u2014briefly",
      "summarize",
      "this",
    ]);

    expect(parsed).toEqual({
      ok: true,
      value: {
        sessionToken: "agent:codex:acp:s1",
        instruction: "\u2014briefly summarize this",
      },
    });
  });
});
