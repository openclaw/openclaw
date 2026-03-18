import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPluginExtensionImportBoundaryInventory,
  diffInventory,
} from "../scripts/check-plugin-extension-import-boundary.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "check-plugin-extension-import-boundary.mjs");
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);

function readBaseline() {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

describe("plugin extension import boundary inventory", () => {
  it("keeps web-search-providers out of the remaining inventory", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();

    expect(inventory.some((entry) => entry.file === "src/plugins/web-search-providers.ts")).toBe(
      false,
    );
  });

  it("ignores plugin-sdk boundary shims by scope", async () => {
    const inventory = await collectPluginExtensionImportBoundaryInventory();

    expect(inventory.some((entry) => entry.file.startsWith("src/plugin-sdk/"))).toBe(false);
    expect(inventory.some((entry) => entry.file.startsWith("src/plugin-sdk-internal/"))).toBe(
      false,
    );
  });

  it("produces stable sorted output", async () => {
    const first = await collectPluginExtensionImportBoundaryInventory();
    const second = await collectPluginExtensionImportBoundaryInventory();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("matches the checked-in baseline", async () => {
    const expected = readBaseline();
    const actual = await collectPluginExtensionImportBoundaryInventory();

    expect(diffInventory(expected, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it("script json output matches the baseline exactly", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(JSON.parse(stdout)).toEqual(readBaseline());
  });
});
