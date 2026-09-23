// Tests shared ACP command helpers for formatting and identifiers.
import { describe, expect, it } from "vitest";
import { formatRuntimeOptionsText, parseSpawnInput, parseSteerInput } from "./shared.js";

describe("formatRuntimeOptionsText", () => {
  it("shows accepted thinking next to the selected model", () => {
    expect(formatRuntimeOptionsText({ model: "openai/gpt-5.6-luna", thinking: "medium" })).toBe(
      "model=openai/gpt-5.6-luna, thinking=medium",
    );
    expect(formatRuntimeOptionsText({ model: "openai/gpt-5.6-luna" })).toBe(
      "model=openai/gpt-5.6-luna",
    );
  });
});

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

  it.each([
    [["--session", " primary ", "one", "two"], "primary", "one two"],
    [["--session= primary ", "one", "two"], "primary", "one two"],
    [["--session=--literal", "one"], "--literal", "one"],
    [["--session=—target", "one"], "—target", "one"],
    [
      ["one", "--session", "first", "two", "--session=second", "—literal"],
      "second",
      "one two —literal",
    ],
  ])(
    "consumes session values without changing instructions: %s",
    (tokens, sessionToken, instruction) => {
      expect(parseSteerInput(tokens)).toEqual({
        ok: true,
        value: { sessionToken, instruction },
      });
    },
  );

  it.each([
    { tokens: ["--session"] },
    { tokens: ["--session", "", "one"] },
    { tokens: ["--session", "  ", "one"] },
    { tokens: ["--session", "--next", "one"] },
    { tokens: ["--session", "—next", "one"] },
    { tokens: ["--session=", "one"] },
    { tokens: ["--session=  ", "one"] },
  ])("rejects missing session values: $tokens", ({ tokens }) => {
    expect(parseSteerInput(tokens)).toEqual({
      ok: false,
      error:
        "--session requires a value. Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>",
    });
  });
});

describe("parseSpawnInput", () => {
  it("rejects mixing --thread and --bind on the same spawn", () => {
    const parsed = parseSpawnInput(
      {
        cfg: {},
        ctx: {},
        command: {},
      } as never,
      ["codex", "--thread", "here", "--bind", "here"],
    );

    expect(parsed).toEqual({
      ok: false,
      error:
        "Use either --thread or --bind for /acp spawn, not both. Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].",
    });
  });
});
