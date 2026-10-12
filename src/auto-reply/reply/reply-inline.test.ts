// Tests inline reply directive parsing and whitespace-preserving behavior.
import { describe, expect, it } from "vitest";
import { extractInlineSimpleCommand, stripInlineStatus } from "./reply-inline.js";

describe("stripInlineStatus", () => {
  it.each([
    ["start  here /status and\tthere /STATUS\r\n    code", "start  here and\tthere\r\n    code"],
  ])("removes only status spans and their separators: %j", (body, cleaned) => {
    expect(stripInlineStatus(body)).toEqual({ cleaned, didStrip: true });
  });
});

describe("extractInlineSimpleCommand", () => {
  it("preserves newlines after extracting command", () => {
    const result = extractInlineSimpleCommand("/help first line\nsecond line");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("first line\nsecond line");
  });

  it.each([["/ID", "/whoami"]])(
    "preserves code bytes when extracting %s",
    (command, expectedCommand) => {
      const code = "    if ready:\r\n\t\trun('a  b')  \r\n";
      expect(extractInlineSimpleCommand(`${command}\r\n${code}`)).toEqual({
        command: expectedCommand,
        cleaned: code,
      });
    },
  );

  it("returns null for empty body", () => {
    expect(extractInlineSimpleCommand("")).toBeNull();
    expect(extractInlineSimpleCommand(undefined)).toBeNull();
  });
});
