// Covers shell inline command flag parsing.
import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it.each([
    [["bash", "-lc", "echo hi"], {}, "echo hi", 2],
    [["sh", "-cecho hi"], { allowCombinedC: true }, "echo hi", 1],
    [["bash", "-cx", "echo hi"], { allowCombinedC: true }, "echo hi", 2],
    [["bash", "-cs", "echo hi"], { allowCombinedC: true }, "echo hi", 2],
    [["yash", "--cmdline", "echo hi"], {}, "echo hi", 2],
    [["yash", "-xc", "echo hi"], { allowCombinedC: true }, "echo hi", 2],
    [["sh", "-cecho hi"], { allowCombinedC: false }, null, null],
    [["bash", "-lc", "   "], {}, null, 2],
    [["bash", "-lc"], {}, null, null],
  ] satisfies Array<[string[], { allowCombinedC?: boolean }, string | null, number | null]>)(
    "parses %j with %j",
    (argv, opts, command, valueTokenIndex) => {
      expect(resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, opts)).toEqual({
        command,
        valueTokenIndex,
      });
    },
  );

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({ command: null, valueTokenIndex: null });
  });
});

const encoded = "VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA";

describe("resolvePowerShellInlineCommandMatch", () => {
  it.each([
    [["pwsh", "script.ps1", "-en", encoded], null, null],
    [["pwsh", "-WorkingDirectory", "/tmp/project", "-en", encoded], encoded, 4],
    [["pwsh", "-win", "hidden", "/ec", encoded], encoded, 4],
    [["pwsh", "-WorkingDir", "/tmp/project", "/ec", encoded], encoded, 4],
    [["pwsh", "-if", "XML", "-EncodedCommand", encoded], encoded, 4],
    [["pwsh", "/if", "XML", "/ec", encoded], encoded, 4],
    [["pwsh", "-config", "SomeConfig", "-ec", encoded], encoded, 4],
    [["pwsh", "-cus", "pipe-name", "-ec", encoded], encoded, 4],
    [["pwsh", "-cwa", "Write-Output", "hi"], "Write-Output hi", 2],
    [["pwsh", "/ec", encoded], encoded, 2],
    [["pwsh", "/NoProfile", "/ec", encoded], encoded, 3],
    [["/usr/bin/pwsh", "/tmp/script.ps1", "/ec", encoded], null, null],
    [["pwsh", "-en", encoded], encoded, 2],
    [["pwsh", "-ea", "stop", "-Command", "Get-Date"], "Get-Date", 4],
    [["pwsh", "/ea", "stop", "-Command", "Get-Date"], "Get-Date", 4],
    [["pwsh", "/ep", "Bypass", "/c", "Get-Date"], "Get-Date", 4],
    [["pwsh", "-to", "token-value", "-Command", "Get-Date"], "Get-Date", 4],
    [["pwsh", "-utc", "1234", "-Command", "Get-Date"], "Get-Date", 4],
    [["pwsh", "-encodeda", "YQByAGcA", "-Command", "Get-Date"], "Get-Date", 4],
    [["pwsh", "-File", "script.ps1", "-ExtraArg"], "script.ps1", 2],
    [["pwsh", "-WorkingDir", "/ec", encoded], null, null],
  ] satisfies Array<[string[], string | null, number | null]>)(
    "parses %j",
    (argv, command, valueTokenIndex) => {
      expect(resolvePowerShellInlineCommandMatch(argv)).toEqual({ command, valueTokenIndex });
    },
  );
});
