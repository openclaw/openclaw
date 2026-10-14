import { expect, it } from "vitest";
import { parseWindowsNativeCommandLine } from "./windows-command-line.js";

it.each([
  [String.raw`node.exe "Office \"A\""`, ["node.exe", 'Office "A"']],
  [String.raw`node.exe "Office ""A"""`, ["node.exe", 'Office "A"']],
  [String.raw`node.exe "C:\Team Notes\\"`, ["node.exe", "C:\\Team Notes\\"]],
  [String.raw`node.exe "a\\\"b" "a\\\\"`, ["node.exe", 'a\\"b', "a\\\\"]],
  [String.raw`node.exe "" middle ""`, ["node.exe", "", "middle", ""]],
  [String.raw`node.exe "%%PATH%% ^!value!"`, ["node.exe", "%%PATH%% ^!value!"]],
  ['node.exe "first\r\nsecond"', ["node.exe", "first\r\nsecond"]],
  ["node.exe tail\r\n", ["node.exe", "tail\r\n"]],
  [String.raw`"C:\tool path\" --flag`, ["C:\\tool path\\", "--flag"]],
  ['"unterminated.exe', null],
  ["bad\0value", null],
] as const)("parses Windows native command line %s without batch expansion", (raw, expected) => {
  expect(parseWindowsNativeCommandLine(raw)).toEqual(expected);
});
