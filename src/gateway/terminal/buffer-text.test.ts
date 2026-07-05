import { describe, expect, it } from "vitest";
import { renderTerminalBufferText } from "./buffer-text.js";

describe("renderTerminalBufferText", () => {
  it("strips ANSI color and erase sequences", () => {
    expect(renderTerminalBufferText("\u001b[32mok\u001b[0m done\u001b[2K")).toBe("ok done");
  });

  it("collapses carriage-return overwrites to the last write per line", () => {
    expect(renderTerminalBufferText("10%\r20%\r100%\ndone")).toBe("100%\ndone");
  });

  it("keeps text before a line-terminating CRLF", () => {
    expect(renderTerminalBufferText("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("drops residual control bytes but keeps tabs", () => {
    expect(renderTerminalBufferText("a\u0007b\tc")).toBe("ab\tc");
  });

  it("strips OSC title sequences", () => {
    expect(renderTerminalBufferText("\u001b]0;title\u0007prompt$ ")).toBe("prompt$ ");
  });
});
