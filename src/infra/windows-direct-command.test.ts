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

  it.each(["&", "|", "<", ">", "^", "(", ")", "%", "!", "\n", "\r\n"])(
    "keeps %j literal inside double quotes",
    (ch) => {
      expect(splitWindowsDirectCommandLine(`tool "a${ch}b" next`)).toEqual([
        "tool",
        `a${ch}b`,
        "next",
      ]);
    },
  );

  it.each(["&", "|", "<", ">", "^", "(", ")", "\n", "\r"])(
    "keeps %j outside double quotes on the cmd.exe path",
    (ch) => {
      expect(splitWindowsDirectCommandLine(`tool a${ch}b`)).toBeNull();
    },
  );

  it("passes percent and exclamation marks outside quotes literally", () => {
    expect(splitWindowsDirectCommandLine("tool 50% %PATH% done!")).toEqual([
      "tool",
      "50%",
      "%PATH%",
      "done!",
    ]);
  });

  it.each([
    ["an escaped quote", 'tool "say \\"hi\\""', ["tool", 'say "hi"']],
    ["an escaped quote outside quotes", 'tool a\\"b', ["tool", 'a"b']],
    ["two backslashes before a closing quote", 'tool "a\\\\"b c', ["tool", "a\\b", "c"]],
    ["three backslashes before a quote", 'tool "a\\\\\\"b"', ["tool", 'a\\"b']],
    ["four backslashes before an opening quote", 'tool a\\\\\\\\"b c"', ["tool", "a\\\\b c"]],
    [
      "backslashes not followed by a quote",
      'tool C:\\dir\\ "C:\\dir\\\\"',
      ["tool", "C:\\dir\\", "C:\\dir\\"],
    ],
    ["doubled quotes inside quotes", 'tool "a""b"', ["tool", 'a"b']],
    ["tripled quotes", 'tool """a"""', ["tool", '"a"']],
    ["a quote glued after a closing quote", 'tool "a"b', ["tool", "ab"]],
    ["quotes inside a token", 'tool a"b c"d', ["tool", "ab cd"]],
    ["an empty argument", 'tool "" x', ["tool", "", "x"]],
  ])("follows the Windows rules for %s", (_label, command, argv) => {
    expect(splitWindowsDirectCommandLine(command)).toEqual(argv);
  });

  it.each([
    ["an unbalanced quote", 'tool "open'],
    ["an escaped quote that leaves a quote open", 'tool "C:\\dir\\"'],
    ["doubled quotes on which the runtime and CommandLineToArgvW disagree", 'tool "a""b c" d'],
    ["a control character", "tool a\u0007b"],
    ["a control character inside quotes", 'tool "a\u0007b"'],
    ["an empty command", "   "],
    ["an empty program", '"" x'],
    ["a program glued to its closing quote", '"C:\\tool.exe"x'],
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
