import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExtensionPluginSdkBoundaryInventory,
  main,
} from "../scripts/check-extension-plugin-sdk-boundary.mjs";

const repoRoot = process.cwd();
const relativeOutsidePackageBaselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "extension-relative-outside-package-inventory.json",
);

function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

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

  it("script json output is empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--mode=src-outside-plugin-sdk", "--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");

    expect(inventory).toEqual([]);
  });

  it("script json output is empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--mode=plugin-sdk-internal", "--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});

describe("extension relative-outside-package boundary inventory", () => {
  it("matches the checked-in baseline", async () => {
    const inventory = await collectExtensionPluginSdkBoundaryInventory("relative-outside-package");
    const expected = JSON.parse(fs.readFileSync(relativeOutsidePackageBaselinePath, "utf8"));

    expect(inventory).toEqual(expected);
  });

  it("script json output matches the checked-in baseline", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--mode=relative-outside-package", "--json"], captured.io);
    const expected = JSON.parse(fs.readFileSync(relativeOutsidePackageBaselinePath, "utf8"));

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual(expected);
  });
});
