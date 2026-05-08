import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts", "pre-commit", "filter-staged-files.mjs");

function filterFiles(mode: "format" | "lint", files: string[]): string[] {
  const output = execFileSync(process.execPath, [scriptPath, mode, "--", ...files], {
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

describe("pre-commit staged-file filter", () => {
  it("does not format generated Kysely declaration files", () => {
    expect(
      filterFiles("format", [
        "src/state/openclaw-state-db.generated.d.ts",
        "src/state/openclaw-state-db.ts",
      ]),
    ).toEqual(["src/state/openclaw-state-db.ts"]);
  });
});
