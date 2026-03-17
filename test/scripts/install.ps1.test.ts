import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function extractFunctionBody(source: string, name: string): string {
  const signature = `function ${name} {`;
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
      if (bodyStart === -1) {
        bodyStart = i + 1;
      }
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && bodyStart !== -1) {
        return source.slice(bodyStart, i);
      }
    }
  }

  throw new Error(`Could not extract body for ${name}`);
}

describe("scripts/install.ps1 failure handling", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../scripts/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  it("does not exit directly from inside Main", () => {
    const mainBody = extractFunctionBody(source, "Main");
    expect(mainBody).not.toMatch(/\bexit\b/i);
  });

  it("only exits at the top level when invoked as a script file", () => {
    expect(source).toMatch(
      /if \(-not \$installSucceeded -and \$PSCommandPath\) \{\s+exit \$script:InstallExitCode\s+\}/m,
    );
  });
});
