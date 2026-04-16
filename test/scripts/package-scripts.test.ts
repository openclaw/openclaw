import fs from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts?: Record<string, string>;
};

function shellTokens(command: string): string[] {
  return (
    command
      .match(/(?:"[^"]*"|'[^']*'|\S+)/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? []
  );
}

describe("package.json scripts", () => {
  it("do not reference missing local script files", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as PackageJson;
    const missingReferences: string[] = [];

    for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
      for (const token of shellTokens(command)) {
        if (/^scripts\/.+\.(?:js|mjs|ts|sh|py)$/.test(token) && !fs.existsSync(token)) {
          missingReferences.push(`${scriptName}: ${token}`);
        }
      }
    }

    expect(missingReferences).toEqual([]);
  });
});
