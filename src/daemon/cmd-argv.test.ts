// Daemon command argv tests cover command argument construction.
import { describe, expect, it } from "vitest";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { parseCmdScriptCommandLine, quoteCmdScriptArg } from "./cmd-argv.js";

describe("cmd argv helpers", () => {
  it.each([
    ["C:\\path\\", "C:\\path\\"],
    ["C:\\Program Files\\OpenClaw\\", '"C:\\Program Files\\OpenClaw\\\\"'],
    ["a b\\\\", '"a b\\\\\\\\"'],
    ["a\\\\b c", '"a\\\\b c"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['a\\\\"b', '"a\\\\\\\\\\"b"'],
    ['a"\\', '"a\\"\\\\"'],
  ])("preserves native argv and readback for %j", (argument, expected) => {
    const encoded = quoteCmdScriptArg(argument);
    expect(encoded).toBe(expected);
    const command = `node.exe ${encoded} SENTINEL-NEXT`;
    const argv = ["node.exe", argument, "SENTINEL-NEXT"];
    expect(parseWindowsNativeCommandLine(command)).toEqual(argv);
    expect(parseCmdScriptCommandLine(command)).toEqual(argv);
  });

  it.each(["", "safe|whoami", "safe<in", "safe>out", "safe^caret"])(
    "round-trips single arg: %p",
    (arg) => {
      const encoded = quoteCmdScriptArg(arg);
      expect(parseCmdScriptCommandLine(encoded)).toEqual([arg]);
    },
  );

  it("round-trips mixed command lines", () => {
    const args = [
      "node",
      "gateway.js",
      "--display-name",
      "",
      "safe&whoami",
      "--percent",
      "%TEMP%",
      "--bang",
      "!token!",
      "--quoted",
      'he said "hi"',
      "",
    ];
    const encoded = args.map((arg) => quoteCmdScriptArg(arg)).join(" ");
    expect(parseCmdScriptCommandLine(encoded)).toEqual(args);
  });

  it("rejects CR/LF in command arguments", () => {
    expect(() => quoteCmdScriptArg("bad\narg")).toThrow(/Command argument cannot contain CR or LF/);
    expect(() => quoteCmdScriptArg("bad\rarg")).toThrow(/Command argument cannot contain CR or LF/);
  });
});
