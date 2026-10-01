import { describe, expect, it } from "vitest";
import { parseWindowsNativeCommandLine } from "./windows-command-line.js";

describe("Windows native command lines", () => {
  it.each([
    [String.raw`"Office \"A\""`, ['Office "A"']],
    [String.raw`"Office ""A"""`, ['Office "A"']],
    [String.raw`"C:\Team Notes\\"`, ["C:\\Team Notes\\"]],
    [String.raw`"a\\\"b" "a\\\\"`, ['a\\"b', "a\\\\"]],
    [String.raw`"" middle ""`, ["", "middle", ""]],
    [String.raw`"%%PATH%% ^!value!"`, ["%%PATH%% ^!value!"]],
    ['"first\r\nsecond"', ["first\r\nsecond"]],
    ["tail\r\n", ["tail\r\n"]],
  ] as const)("decodes native arguments %s without batch expansion", (raw, expected) => {
    expect(parseWindowsNativeCommandLine(`node.exe ${raw}`)).toEqual(["node.exe", ...expected]);
  });

  it("uses executable-token rules only for a full command line", () => {
    expect(parseWindowsNativeCommandLine(String.raw`"C:\tool path\" --flag`)).toEqual([
      "C:\\tool path\\",
      "--flag",
    ]);
    expect(parseWindowsNativeCommandLine('"unterminated.exe')).toBeNull();
  });

  it("refuses NUL in native command text", () => {
    expect(parseWindowsNativeCommandLine("bad\0value")).toBeNull();
  });
});
