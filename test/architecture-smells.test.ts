import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectArchitectureSmells } from "../scripts/check-architecture-smells.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "check-architecture-smells.mjs");

describe("architecture smell inventory", () => {
  it("produces stable sorted output", async () => {
    const first = await collectArchitectureSmells();
    const second = await collectArchitectureSmells();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.category.localeCompare(right.category) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("script json output matches the collector", async () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(JSON.parse(stdout)).toEqual(await collectArchitectureSmells());
  });
});
