// Verifies command explanation spans are reduced to executable highlights and
// suppressed for unsupported shell-wrapper grammars.
import { describe, expect, it } from "vitest";
import { explainShellCommand } from "./extract.js";
import { formatCommandSpans } from "./format.js";
import type { CommandExplanation, SourceSpan } from "./types.js";

function span(startIndex: number, endIndex: number): SourceSpan {
  return {
    startIndex,
    endIndex,
    startPosition: { row: 0, column: startIndex },
    endPosition: { row: 0, column: endIndex },
  };
}

describe("formatCommandSpans", () => {
  it("returns executable token spans without risk or severity metadata", async () => {
    const explanation = await explainShellCommand('ls | grep "stuff" | python -c \'print("hi")\'');

    expect(formatCommandSpans(explanation)).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ]);
  });

  it("omits command spans for unsupported shell wrappers through transparent carriers", async () => {
    const timeoutPowershell = await explainShellCommand('timeout 5 pwsh -Command "Get-ChildItem"');
    const timeCmd = await explainShellCommand('time cmd.exe /d /s /c "dir"');
    const splitEnvPowershell = await explainShellCommand("env -S 'pwsh -Command Get-ChildItem'");

    expect(formatCommandSpans(timeoutPowershell)).toEqual([]);
    expect(formatCommandSpans(timeCmd)).toEqual([]);
    expect(formatCommandSpans(splitEnvPowershell)).toEqual([]);
  });

  it("ignores invalid executable spans", () => {
    const explanation: CommandExplanation = {
      ok: true,
      source: "echo hi",
      shapes: [],
      topLevelCommands: [
        {
          context: "top-level",
          executable: "echo",
          argv: ["echo", "hi"],
          text: "echo hi",
          span: span(0, 7),
          executableSpan: span(4, 4),
        },
      ],
      nestedCommands: [],
      risks: [],
    };

    expect(formatCommandSpans(explanation)).toStrictEqual([]);
  });
});
