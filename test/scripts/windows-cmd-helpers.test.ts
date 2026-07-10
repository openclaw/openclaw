// Windows cmd helper tests cover argv quoting used by script runners.
import { describe, expect, it } from "vitest";
import { buildCmdExeCommandLine } from "../../scripts/windows-cmd-helpers.mjs";

describe("windows-cmd-helpers", () => {
  it("preserves empty Windows cmd.exe arguments", () => {
    expect(buildCmdExeCommandLine("pnpm.cmd", ["exec", "", "vitest"])).toBe(
      'pnpm.cmd exec "" vitest',
    );
  });

  it("preserves empty arguments when the command also needs outer quotes", () => {
    expect(buildCmdExeCommandLine("C:\\Program Files\\pnpm\\pnpm.cmd", ["exec", ""])).toBe(
      '""C:\\Program Files\\pnpm\\pnpm.cmd" exec """',
    );
  });
});
