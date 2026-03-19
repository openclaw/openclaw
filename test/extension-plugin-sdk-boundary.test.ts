import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectExtensionPluginSdkBoundaryInventory } from "../scripts/check-extension-plugin-sdk-boundary.mjs";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "check-extension-plugin-sdk-boundary.mjs");
const relativeOutsidePackageBaselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "extension-relative-outside-package-inventory.json",
);

describe("extension src outside plugin-sdk boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");

    expect(inventory).toEqual([]);
  });

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

  it("script json output is empty", () => {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--mode=src-outside-plugin-sdk", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");

    expect(inventory).toEqual([]);
  });

  it("script json output is empty", () => {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--mode=plugin-sdk-internal", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe("extension relative-outside-package boundary inventory", () => {
  it("matches the checked-in baseline", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("relative-outside-package");
    const expected = JSON.parse(fs.readFileSync(relativeOutsidePackageBaselinePath, "utf8"));

    expect(inventory).toEqual(expected);
  });

  it("script json output matches the checked-in baseline", () => {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--mode=relative-outside-package", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    const expected = JSON.parse(fs.readFileSync(relativeOutsidePackageBaselinePath, "utf8"));

    expect(JSON.parse(stdout)).toEqual(expected);
  });
});
