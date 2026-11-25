import { afterEach, describe, expect, it } from "vitest";
import { isTerminalInteractive } from "./terminal-interactivity.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const tty = createCliTtyMock([process.stdin]);

afterEach(() => {
  tty.restore();
});

describe("isTerminalInteractive", () => {
  it("checks stdin with an explicitly selected output stream", () => {
    tty.set(true);
    const stderrLikeOutput = { isTTY: true };

    expect(isTerminalInteractive(stderrLikeOutput)).toBe(true);
    expect(isTerminalInteractive({ isTTY: false })).toBe(false);
  });
});
