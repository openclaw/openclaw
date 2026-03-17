import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function extractMainBody(source: string): string {
  const match = source.match(/^function Main \{\r?\n([\s\S]*?)^}\r?\n\r?\n\$installSucceeded = Main/m);
  expect(match?.[1]).toBeDefined();
  return match![1];
}

describe("scripts/install.ps1 failure handling", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../scripts/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  it("does not exit directly from inside Main", () => {
    const mainBody = extractMainBody(source);
    expect(mainBody).not.toMatch(/\bexit\b/i);
  });

  it("only exits at the top level when invoked as a script file", () => {
    expect(source).toMatch(
      /if \(\$PSCommandPath\) \{\s+exit \$script:InstallExitCode\s+\}/m,
    );
  });

  it("throws for scriptblock installs so failures still surface without exiting the host", () => {
    expect(source).toMatch(
      /Complete-Install -Succeeded:\$installSucceeded/,
    );
    expect(source).toMatch(
      /throw "OpenClaw installation failed with exit code \$\(\$script:InstallExitCode\)\."/m,
    );
  });
});
