import { describe, expect, it } from "vitest";
import {
  resolveWindowsDirectCommandArgv,
  splitWindowsDirectCommandLine,
} from "./windows-direct-command.js";

describe("splitWindowsDirectCommandLine", () => {
  it.each([
    ["C:\\bin\\tool.exe a b", ["C:\\bin\\tool.exe", "a", "b"]],
    [
      '"C:\\Program Files\\Tool\\tool.exe" "deux mots é" x',
      ["C:\\Program Files\\Tool\\tool.exe", "deux mots é", "x"],
    ],
    ["  git\tstatus   --short  ", ["git", "status", "--short"]],
    ['tool "" last', ["tool", "", "last"]],
    ["tool C:\\dir\\", ["tool", "C:\\dir\\"]],
    ["tool it's", ["tool", "it's"]],
    ["tool --name=value C:/forward/slash", ["tool", "--name=value", "C:/forward/slash"]],
  ])("splits %j", (command, argv) => {
    expect(splitWindowsDirectCommandLine(command)).toEqual(argv);
  });

  it.each(["&", "|", "<", ">", "^", "%", "!", "(", ")", "\n", "\r"])(
    "refuses %j outside and inside double quotes",
    (ch) => {
      expect(splitWindowsDirectCommandLine(`tool a${ch}b`)).toBeNull();
      expect(splitWindowsDirectCommandLine(`tool "a${ch}b"`)).toBeNull();
    },
  );

  it.each([
    ["an unbalanced quote", 'tool "open'],
    ["a backslash before a closing quote", 'tool "C:\\dir\\"'],
    ["a backslash before an opening quote", 'tool \\"x"'],
    ["a quote inside a token", 'tool a"b c"d'],
    ["a quote glued after a closing quote", 'tool "a"b'],
    ["adjacent quoted sections", 'tool "a""b"'],
    ["a control character", "tool a\u0007b"],
    ["an empty command", "   "],
  ])("refuses %s", (_label, command) => {
    expect(splitWindowsDirectCommandLine(command)).toBeNull();
  });
});

describe("resolveWindowsDirectCommandArgv", () => {
  it("returns the argv of an eligible command", () => {
    expect(
      resolveWindowsDirectCommandArgv('"C:\\Program Files\\Git\\cmd\\git.exe" log "two words"'),
    ).toEqual(["C:\\Program Files\\Git\\cmd\\git.exe", "log", "two words"]);
  });

  it.each([
    "dir C:\\",
    "ECHO hello",
    "echo. hello",
    "cd.. ",
    "set NAME",
    "type file.txt",
    "start notepad.exe",
    "C:\\tools\\copy.exe a b",
  ])("keeps the cmd.exe internal command %j on the shell path", (command) => {
    expect(resolveWindowsDirectCommandArgv(command)).toBeNull();
  });

  it.each([
    "build.cmd",
    "C:\\scripts\\deploy.BAT --prod",
    '"C:\\My Scripts\\run.cmd" arg',
    "C:\\scripts\\deploy.bat.",
  ])("keeps the batch script %j on the shell path", (command) => {
    expect(resolveWindowsDirectCommandArgv(command)).toBeNull();
  });

  it.each([
    "cmd /d /s /c whoami",
    "cmd.exe /c hostname",
    "C:\\Windows\\System32\\cmd.exe /d /s /c hostname",
    "powershell -Command Get-Date",
    "pwsh.exe -NoProfile -Command Get-Date",
  ])("keeps the shell wrapper %j on the shell path", (command) => {
    expect(resolveWindowsDirectCommandArgv(command)).toBeNull();
  });

  it.each(["director.exe --version", "settings.exe", "typescript-check.exe"])(
    "does not mistake %j for an internal command",
    (command) => {
      expect(resolveWindowsDirectCommandArgv(command)).not.toBeNull();
    },
  );
});
