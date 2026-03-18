import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExtensionPluginSdkBoundaryInventory,
  diffInventory,
} from "../scripts/check-extension-plugin-sdk-boundary.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "check-extension-plugin-sdk-boundary.mjs");

function readBaseline(fileName: string) {
  return JSON.parse(readFileSync(path.join(repoRoot, "test", "fixtures", fileName), "utf8"));
}

describe("extension src outside plugin-sdk boundary inventory", () => {
  it("produces stable sorted output", async () => {
    const first = await collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");
    const second = await collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.resolvedPath.localeCompare(right.resolvedPath) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("captures known current production violations", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");

    expect(inventory).toContainEqual(
      expect.objectContaining({
        file: "extensions/brave/src/brave-web-search-provider.ts",
        resolvedPath: "src/agents/tools/common.js",
      }),
    );
    expect(inventory).toContainEqual(
      expect.objectContaining({
        file: "extensions/discord/src/runtime-api.ts",
        resolvedPath: "src/config/types.secrets.js",
      }),
    );
  });

  it("matches the checked-in baseline", async () => {
    const expected = readBaseline("extension-src-outside-plugin-sdk-inventory.json");
    const actual = await collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");

    expect(diffInventory(expected, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it("script json output matches the baseline exactly", () => {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--mode=src-outside-plugin-sdk", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(JSON.parse(stdout)).toEqual(
      readBaseline("extension-src-outside-plugin-sdk-inventory.json"),
    );
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");

    expect(inventory).toEqual([]);
  });

  it("matches the checked-in empty baseline", async () => {
    const expected = readBaseline("extension-plugin-sdk-internal-inventory.json");
    const actual = await collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");

    expect(diffInventory(expected, actual)).toEqual({ missing: [], unexpected: [] });
  });

  it("script json output matches the empty baseline exactly", () => {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--mode=plugin-sdk-internal", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(JSON.parse(stdout)).toEqual(
      readBaseline("extension-plugin-sdk-internal-inventory.json"),
    );
  });
});
