import { describe, expect, it } from "vitest";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  POWERSHELL_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";

describe("resolveInlineCommandMatch", () => {
  it("extracts the next token for exact inline-command flags", () => {
    expect(
      resolveInlineCommandMatch(["bash", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: "echo hi",
      valueTokenIndex: 2,
    });
    expect(
      resolveInlineCommandMatch(
        ["pwsh", "-Command", "Get-ChildItem"],
        POWERSHELL_INLINE_COMMAND_FLAGS,
      ),
    ).toEqual({
      command: "Get-ChildItem",
      valueTokenIndex: 2,
    });
    expect(
      resolveInlineCommandMatch(["pwsh", "-File", "script.ps1"], POWERSHELL_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: "script.ps1",
      valueTokenIndex: 2,
    });
    expect(
      resolveInlineCommandMatch(
        ["powershell", "-f", "script.ps1"],
        POWERSHELL_INLINE_COMMAND_FLAGS,
      ),
    ).toEqual({
      command: "script.ps1",
      valueTokenIndex: 2,
    });
  });

  it("supports combined -c forms only when enabled", () => {
    expect(
      resolveInlineCommandMatch(["sh", "-cecho hi"], POSIX_INLINE_COMMAND_FLAGS, {
        allowCombinedC: true,
      }),
    ).toEqual({
      command: "echo hi",
      valueTokenIndex: 1,
    });
    expect(
      resolveInlineCommandMatch(["sh", "-cecho hi"], POSIX_INLINE_COMMAND_FLAGS, {
        allowCombinedC: false,
      }),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });

  it("returns a value index even when the flag is present without a usable command", () => {
    expect(resolveInlineCommandMatch(["bash", "-lc", "   "], POSIX_INLINE_COMMAND_FLAGS)).toEqual({
      command: null,
      valueTokenIndex: 2,
    });
    expect(resolveInlineCommandMatch(["bash", "-lc"], POSIX_INLINE_COMMAND_FLAGS)).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });

  it("stops parsing after --", () => {
    expect(
      resolveInlineCommandMatch(["bash", "--", "-lc", "echo hi"], POSIX_INLINE_COMMAND_FLAGS),
    ).toEqual({
      command: null,
      valueTokenIndex: null,
    });
  });
});
