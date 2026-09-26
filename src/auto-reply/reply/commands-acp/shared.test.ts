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
  const params = { cfg: {}, ctx: {}, command: {} } as never;

  it.each(["--mode", "--bind", "--thread", "--cwd", "--label"])(
    "rejects missing values for %s in both option forms",
    (flag) => {
      for (const option of [flag, `${flag}=`]) {
        expect(parseSpawnInput(params, ["codex", option])).toEqual({
          ok: false,
          error: expect.stringContaining(`${flag} requires a value. Usage: /acp spawn`),
        });
      }
    },
  );

  it("preserves option values across mixed equals and separate forms", () => {
    expect(
      parseSpawnInput(params, [
        "codex",
        "--mode=ONESHOT",
        "--thread",
        "off",
        "--bind=here",
        "--cwd",
        "/Workspace/Case",
        "--label=Inbox",
      ]),
    ).toEqual({
      ok: true,
      value: {
        agentId: "codex",
        mode: "oneshot",
        thread: "off",
        bind: "here",
        cwd: "/Workspace/Case",
        label: "Inbox",
      },
    });
  });

  it("rejects mixing --thread and --bind on the same spawn", () => {
    const parsed = parseSpawnInput(params, ["codex", "--thread", "here", "--bind", "here"]);

    expect(parsed).toEqual({
      ok: false,
      error:
        "Use either --thread or --bind for /acp spawn, not both. Usage: /acp spawn [harness-id] [--mode persistent|oneshot] [--thread auto|here|off] [--bind here|off] [--cwd <path>] [--label <label>].",
    });
  });
});
