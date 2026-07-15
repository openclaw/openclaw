import { describe, expect, it, vi } from "vitest";
import { createTerminalDefaultColorQueryResponder } from "./terminal-color-queries.ts";

const DARK_COLORS = { foreground: "#d7dae0", background: "#0e1015", cursor: "#ff5c5c" };
const LIGHT_COLORS = { foreground: "#1b1e26", background: "#f7f8fa", cursor: "#1b1e26" };

describe("terminal default-color query responder", () => {
  it("answers OSC 10 and 11 queries with Ghostty-compatible RGB values", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder(() => DARK_COLORS, reply);

    responder.observe("prefix\u001b]10;?\u001b\\\u001b]11;?\u0007suffix");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]10;rgb:d7d7/dada/e0e0\u001b\\",
      "\u001b]11;rgb:0e0e/1010/1515\u0007",
    ]);
  });

  it("answers multi-parameter queries and preserves their terminator", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder(() => DARK_COLORS, reply);

    responder.observe("\u001b]10;?;?;?\u0007");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]10;rgb:d7d7/dada/e0e0\u0007",
      "\u001b]11;rgb:0e0e/1010/1515\u0007",
      "\u001b]12;rgb:ffff/5c5c/5c5c\u0007",
    ]);
  });

  it("recognizes each query across every stream split", () => {
    for (const query of ["\u001b]10;?\u0007", "\u001b]11;?\u001b\\"]) {
      for (let split = 1; split < query.length; split += 1) {
        const reply = vi.fn();
        const responder = createTerminalDefaultColorQueryResponder(() => DARK_COLORS, reply);

        responder.observe(query.slice(0, split));
        expect(reply).not.toHaveBeenCalled();
        responder.observe(query.slice(split));

        expect(reply).toHaveBeenCalledOnce();
      }
    }
  });

  it("uses the current colors when the terminal theme changes", () => {
    let colors = DARK_COLORS;
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder(() => colors, reply);

    responder.observe("\u001b]11;?\u001b\\");
    colors = LIGHT_COLORS;
    responder.observe("\u001b]11;?\u001b\\");

    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      "\u001b]11;rgb:0e0e/1010/1515\u001b\\",
      "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
    ]);
  });

  it("ignores unrelated OSC commands", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder(() => DARK_COLORS, reply);

    responder.observe("\u001b]13;?\u001b\\");

    expect(reply).not.toHaveBeenCalled();
  });

  it("suppresses historical replies while retaining a replay's trailing query prefix", () => {
    const reply = vi.fn();
    const responder = createTerminalDefaultColorQueryResponder(() => DARK_COLORS, reply);

    responder.primeFromReplay("\u001b]10;?\u001b\\history\u001b]11;");
    expect(reply).not.toHaveBeenCalled();
    responder.observe("?\u001b\\");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith("\u001b]11;rgb:0e0e/1010/1515\u001b\\");
  });
});
