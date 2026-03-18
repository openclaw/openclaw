import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectWebSearchProviderBoundaryInventory } from "../scripts/check-web-search-provider-boundaries.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "check-web-search-provider-boundaries.mjs");

describe("web search provider boundary inventory", () => {
  it("has no remaining production inventory in core", async () => {
    const inventory = await collectWebSearchProviderBoundaryInventory();

    expect(inventory).toEqual([]);
  });

  it("ignores extension-owned registrations", async () => {
    const inventory = await collectWebSearchProviderBoundaryInventory();

    expect(inventory.some((entry) => entry.file.startsWith("extensions/"))).toBe(false);
  });

  it("produces stable sorted output", async () => {
    const first = await collectWebSearchProviderBoundaryInventory();
    const second = await collectWebSearchProviderBoundaryInventory();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("script json output is empty", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(JSON.parse(stdout)).toEqual([]);
  });
});
