import { describe, expect, it } from "vitest";
import {
  collectExtensionPluginSdkBoundaryInventory,
  main,
} from "../scripts/check-extension-plugin-sdk-boundary.mjs";

const srcOutsideInventoryPromise =
  collectExtensionPluginSdkBoundaryInventory("src-outside-plugin-sdk");
const pluginSdkInternalInventoryPromise =
  collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");
const relativeOutsidePackageInventoryPromise = collectExtensionPluginSdkBoundaryInventory(
  "relative-outside-package",
);

async function getJsonOutput(
  mode: Parameters<typeof collectExtensionPluginSdkBoundaryInventory>[0],
) {
  const captured = createCapturedIo();
  const exitCode = await main([`--mode=${mode}`, "--json"], captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

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
    const inventory = await srcOutsideInventoryPromise;

    expect(inventory).toEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await srcOutsideInventoryPromise;
    const second = await srcOutsideInventoryPromise;

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
    const result = await getJsonOutput("src-outside-plugin-sdk");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.json).toEqual([]);
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await pluginSdkInternalInventoryPromise;

    expect(inventory).toEqual([]);
  });

  it("script json output is empty", async () => {
    const result = await getJsonOutput("plugin-sdk-internal");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.json).toEqual([]);
  });
});

describe("extension relative-outside-package boundary inventory", () => {
  it("is currently empty", async () => {
    const inventory = await relativeOutsidePackageInventoryPromise;

    expect(inventory).toEqual([]);
  });

  it("script json output is empty", async () => {
    const result = await getJsonOutput("relative-outside-package");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.json).toEqual([]);
  });
});
