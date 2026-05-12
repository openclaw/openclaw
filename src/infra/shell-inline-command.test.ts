import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  POWERSHELL_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it.each([
    {
      name: "extracts the next token for bash -lc",
      argv: ["bash", "-lc", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -Command",
      argv: ["pwsh", "-Command", "Get-ChildItem"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "Get-ChildItem", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -File",
      argv: ["pwsh", "-File", "script.ps1"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "script.ps1", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -f",
      argv: ["powershell", "-f", "script.ps1"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "script.ps1", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -ec",
      argv: ["pwsh", "-ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell -EC",
      argv: ["pwsh", "-EC", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell encoded-command prefixes",
      argv: ["pwsh", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "extracts the next token for PowerShell slash switch forms",
      argv: ["pwsh", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      flags: POWERSHELL_INLINE_COMMAND_FLAGS,
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "supports combined -c forms when enabled",
      argv: ["sh", "-cecho hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 1 },
    },
    {
      name: "keeps post-c no-argument shell flags separate from the command",
      argv: ["bash", "-cx", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "keeps post-c stdin shell flags separate from the command",
      argv: ["bash", "-cs", "echo hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: true },
      expected: { command: "echo hi", valueTokenIndex: 2 },
    },
    {
      name: "rejects combined -c forms when disabled",
      argv: ["sh", "-cecho hi"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      opts: { allowCombinedC: false },
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "returns a value index for blank command tokens",
      argv: ["bash", "-lc", "   "],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: null, valueTokenIndex: 2 },
    },
    {
      name: "returns null value index when the flag has no following token",
      argv: ["bash", "-lc"],
      flags: POSIX_INLINE_COMMAND_FLAGS,
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, flags, opts, expected }) => {
    expect(resolveInlineCommandMatch(argv, flags, opts)).toEqual(expected);
  });

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });

  it.each([
    {
      name: "stops at an omitted PowerShell script file before script args",
      argv: ["pwsh", "script.ps1", "-en", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: null, valueTokenIndex: null },
    },
    {
      name: "skips PowerShell option values before encoded-command prefixes",
      argv: [
        "pwsh",
        "-WorkingDirectory",
        "/tmp/project",
        "-en",
        "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA",
      ],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips abbreviated PowerShell window style values before slash encoded command",
      argv: ["pwsh", "-win", "hidden", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips abbreviated PowerShell working directory values before slash encoded command",
      argv: [
        "pwsh",
        "-WorkingDir",
        "/tmp/project",
        "/ec",
        "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA",
      ],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell input format alias values before encoded-command prefixes",
      argv: ["pwsh", "-if", "XML", "-EncodedCommand", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips slash PowerShell input format alias values before slash encoded command",
      argv: ["pwsh", "/if", "XML", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell configuration name values before encoded-command prefixes",
      argv: ["pwsh", "-config", "SomeConfig", "-ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "skips PowerShell custom pipe name values before encoded-command prefixes",
      argv: ["pwsh", "-cus", "pipe-name", "-ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 4 },
    },
    {
      name: "extracts the command tail for PowerShell command-with-args",
      argv: ["pwsh", "-cwa", "Write-Output", "hi"],
      expected: { command: "Write-Output hi", valueTokenIndex: 2 },
    },
    {
      name: "extracts PowerShell slash switch forms before script file binding",
      argv: ["pwsh", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 2 },
    },
    {
      name: "keeps scanning after PowerShell slash switches",
      argv: ["pwsh", "/NoProfile", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA", valueTokenIndex: 3 },
    },
    {
      name: "stops at slash paths before PowerShell script args",
      argv: ["/usr/bin/pwsh", "/tmp/script.ps1", "/ec", "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA"],
      expected: { command: null, valueTokenIndex: null },
    },
  ])("$name", ({ argv, expected }) => {
    expect(resolvePowerShellInlineCommandMatch(argv)).toEqual(expected);
  });
});
