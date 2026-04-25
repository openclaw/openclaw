import { describe, expect, it } from "vitest";
import { main as extensionPluginSdkMain } from "../scripts/check-extension-plugin-sdk-boundary.mjs";
import { main as sdkPackageMain } from "../scripts/check-sdk-package-extension-import-boundary.mjs";
import { main as srcExtensionMain } from "../scripts/check-src-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const srcJsonOutputPromise = getJsonOutput(srcExtensionMain, ["--json"]);
const sdkPackageJsonOutputPromise = getJsonOutput(sdkPackageMain, ["--json"]);
const srcOutsideJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=src-outside-plugin-sdk",
  "--json",
]);
const pluginSdkInternalJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=plugin-sdk-internal",
  "--json",
]);
const relativeOutsidePackageJsonOutputPromise = getJsonOutput(extensionPluginSdkMain, [
  "--mode=relative-outside-package",
  "--json",
]);

type CapturedIo = ReturnType<typeof createCapturedIo>["io"];

async function getJsonOutput(
  main: (argv: string[], io: CapturedIo) => Promise<number>,
  argv: string[],
) {
  const captured = createCapturedIo();
  const exitCode = await main(argv, captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}

describe("src extension import boundary inventory", () => {
  it("script json output stays empty", async () => {
    const jsonOutput = await srcJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});

describe("sdk/package extension import boundary inventory", () => {
  it("script json output stays empty", async () => {
    const jsonOutput = await sdkPackageJsonOutputPromise;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toEqual([]);
  });
});

describe("extension src outside plugin-sdk boundary inventory", () => {
  it("script json output stays empty", async () => {
    const jsonResult = await srcOutsideJsonOutputPromise;

    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});

describe("extension plugin-sdk-internal boundary inventory", () => {
  it("script json output stays empty", async () => {
    const jsonResult = await pluginSdkInternalJsonOutputPromise;

    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});

describe("extension relative-outside-package boundary inventory", () => {
  it("script json output stays empty", async () => {
    const jsonResult = await relativeOutsidePackageJsonOutputPromise;

    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.json).toEqual([]);
  });
});
